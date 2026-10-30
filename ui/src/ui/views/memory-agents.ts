/**
 * Memory › Agents — "what does this agent know, and what can it reach?"
 *
 * Live roster of EVERY agent the gateway knows (agents.knowledge.profile, so
 * new agents appear without a code change), a per-agent Knowledge &
 * capabilities profile (identity / memory / knowledge sources / capabilities /
 * activity) and an agents × capability-domains matrix.
 *
 * Live: polls every POLL_MS while connected + visible, refreshes (debounced)
 * on agent/session/notes/kanban/sub-agent gateway events, pauses while the tab
 * is hidden or the element is detached. The server caches for ~5 s, so an
 * event burst costs one rebuild.
 */

import { isIdentityTemplateHint, sanitizeIdentityEmoji } from "../../../../src/shared/identity-emoji.js";
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { GLASS_AGENTS_SHADOW_CSS, glassAurora, glassEmpty } from "./glass-agents-shared.js";
import { ensureMemoryHostSubtabsStyle } from "./glass-memory.js";
import { customElement, property, state } from "lit/decorators.js";

import { gatewayCall, getGatewayClient } from "../gateway-client.js";
import type { GatewayEventFrame } from "../gateway.js";
import {
  EVENT_DEBOUNCE_MS,
  POLL_MS,
  PROFILE_METHOD,
  cellIntensity,
  domainMaxima,
  filterRoster,
  fleetSummary,
  formatAgo,
  formatBytes,
  formatCount,
  freshness,
  isRelevantEvent,
  mergeSources,
  shortModel,
  sortRoster,
  sortSources,
  statusLabel,
  type AgentKnowledgeProfile,
  type KnowledgeProfileResult,
  type SourceView,
} from "./memory-agents-model.js";

type Mode = "profile" | "matrix";

const LS_SELECTED = "ib.memoryAgents.selected";
const LS_MODE = "ib.memoryAgents.mode";

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const ICON = {
  check: html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cross: html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  refresh: html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  arrow: html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  file: html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  warn: html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2l6.5 11.5h-13z M8 6.5v3.5 M8 12v.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const ACCESS_LABELS: Record<string, string> = {
  files: "Files",
  exec: "Shell",
  web: "Web",
  browser: "Browser",
  messaging: "Messaging",
  voice: "Voice",
  computerUse: "Computer use",
};

@customElement("memory-agents-view")
export class MemoryAgentsView extends LitElement {
  /** Open an identity file in the existing Sovereign Memory identity editor. */
  @property({ attribute: false }) onOpenIdentity?: (agentId: string, filename: string) => void;
  /** Navigate to a tab id (deep links to knowledge sources). */
  @property({ attribute: false }) onNavigate?: (tab: string) => void;
  @property({ attribute: false }) basePath = "";

  @state() private data: KnowledgeProfileResult | null = null;
  @state() private loading = false;
  @state() private error = "";
  @state() private selectedId: string | null = lsGet(LS_SELECTED);
  @state() private mode: Mode = lsGet(LS_MODE) === "matrix" ? "matrix" : "profile";
  @state() private query = "";
  @state() private showUnavailableTools = false;
  @state() private fetchedAt = 0;
  @state() private now = Date.now();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private subscribedClient: unknown = null;

  connectedCallback() {
    super.connectedCallback();
    const root = this.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) ensureMemoryHostSubtabsStyle(root);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.startLive();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopLive();
  }

  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.stopLive();
    else this.startLive();
  };

  private startLive() {
    this.stopLive();
    void this.refresh();
    this.pollTimer = setInterval(() => {
      this.now = Date.now();
      void this.refresh();
    }, POLL_MS);
    this.subscribe();
  }

  private stopLive() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribedClient = null;
  }

  /** (Re)attach to the current gateway client — it changes on reconnect. */
  private subscribe() {
    const client = getGatewayClient();
    if (!client || client === this.subscribedClient) return;
    this.unsubscribe?.();
    this.subscribedClient = client;
    this.unsubscribe = client.subscribe((evt: GatewayEventFrame) => {
      if (!isRelevantEvent(evt.event)) return;
      if (this.debounceTimer) return;
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.refresh();
      }, EVENT_DEBOUNCE_MS);
    });
  }

  private async refresh(fresh = false) {
    if (this.loading) return;
    this.subscribe();
    if (!getGatewayClient()) {
      if (!this.data) this.error = "Waiting for the gateway connection…";
      return;
    }
    this.loading = true;
    try {
      const res = await gatewayCall<KnowledgeProfileResult>(PROFILE_METHOD, fresh ? { fresh: true } : {});
      this.data = res;
      this.error = "";
      this.fetchedAt = Date.now();
      this.now = this.fetchedAt;
      if (!this.selectedId || !res.agents.some((a) => a.id === this.selectedId)) {
        this.selectedId = sortRoster(res.agents)[0]?.id ?? null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error = /unknown method|not found|unsupported/i.test(msg)
        ? `This gateway doesn't serve ${PROFILE_METHOD} yet — restart the gateway to load it.`
        : msg;
    } finally {
      this.loading = false;
    }
  }

  private select(id: string) {
    this.selectedId = id;
    lsSet(LS_SELECTED, id);
    if (this.mode === "matrix") this.setMode("profile");
    this.renderRoot.querySelector(".profile")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    lsSet(LS_MODE, mode);
  }

  private tabHref(tab: string) {
    return `${this.basePath || ""}/${tab}`.replace(/\/{2,}/g, "/");
  }

  private navigate(e: MouseEvent, tab: string) {
    if (!this.onNavigate || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    this.onNavigate(tab);
  }

  // ── Render ──────────────────────────────────────────────────────────

  render() {
    const summary = fleetSummary(this.data);
    const agents = this.data ? filterRoster(sortRoster(this.data.agents), this.query) : [];
    const selected = this.data?.agents.find((a) => a.id === this.selectedId) ?? null;
    return html`
      <div class="gt-scope ma">
      ${glassAurora()}
      <header class="gt-hero ma-hero">
        <div class="ma-hero__copy">
          <span class="gt-eyebrow">Memory · Agents</span>
          <h1 class="gt-title">Agent knowledge</h1>
          <p class="gt-sub">What each agent knows and what it can reach — identity, memory, sources, tools and live activity.</p>
        </div>
        <div class="gt-stats ma-stats">
          ${this.stat(summary.agents, "agents")}
          ${this.stat(summary.running, "running now", summary.running > 0 ? "live" : "")}
          ${this.stat(summary.activeToday, "active 24h")}
          ${this.stat(summary.subagentsRunning, "sub-agent runs")}
          ${summary.misconfigured
            ? this.stat(summary.misconfigured, "allowlist issues", "warn")
            : nothing}
        </div>
      </header>
      <div class="ma-bar ga-toolbar">
        <div class="gt-seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected=${this.mode === "profile"} class=${this.mode === "profile" ? "on" : ""} @click=${() => this.setMode("profile")}>Profiles</button>
          <button role="tab" aria-selected=${this.mode === "matrix"} class=${this.mode === "matrix" ? "on" : ""} @click=${() => this.setMode("matrix")}>Capability matrix</button>
        </div>
        <input
          class="gt-input search"
          type="search"
          placeholder="Filter agents…"
          aria-label="Filter agents"
          .value=${this.query}
          @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
        />
        <span class="updated" title=${this.data ? `built in ${this.data.tookMs} ms${this.data.cached ? " (cached)" : ""}` : ""}>
          <span class="gt-light" data-state=${this.loading ? "gold" : this.error ? "warn" : this.data ? "ok" : "idle"} ?data-pulse=${this.loading}></span>
          ${this.fetchedAt ? `updated ${formatAgo(this.fetchedAt, this.now)}` : "loading"}
        </span>
        <button class="gt-btn icon-btn" title="Refresh now" aria-label="Refresh now" @click=${() => this.refresh(true)}>${ICON.refresh}</button>
      </div>

      ${this.error ? html`<div class="banner" role="status">${ICON.warn}<span>${this.error}</span></div>` : nothing}
      ${this.data?.errors?.length
        ? html`<details class="errors"><summary>${ICON.warn} ${this.data.errors.length} shared source${this.data.errors.length === 1 ? "" : "s"} could not be read</summary><ul>${this.data.errors.map((e) => html`<li>${e}</li>`)}</ul></details>`
        : nothing}
      ${!this.data && !this.error ? this.renderSkeleton() : nothing}

      ${this.data
        ? this.mode === "matrix"
          ? this.renderMatrix(agents)
          : html`${this.renderRoster(agents)} ${selected ? this.renderProfile(selected) : nothing}`
        : nothing}
      </div>
    `;
  }

  private stat(value: number, label: string, tone = "") {
    return html`<div class="gt-stat gt-glass stat ${tone}">
      <span class="gt-stat-value">${tone === "live" ? html`<span class="gt-light" data-state="ok" data-pulse></span>` : nothing}${value}</span>
      <span class="gt-stat-label">${label}</span>
    </div>`;
  }

  private renderSkeleton() {
    return html`<section class="ga-panel roster-panel" aria-busy="true" aria-label="Loading agents">
      <h2 class="ga-section-head">Roster</h2>
      <div class="roster">${[0, 1, 2, 3, 4, 5, 6, 7].map(
        (i) => html`<div class="agent skeleton" style="--gt-i:${i}">
          <div class="gt-skel" style="width:60%;height:12px"></div>
          <div class="gt-skel" style="width:42%;height:9px"></div>
          <div class="gt-skel" style="width:85%;height:9px"></div>
          <div class="gt-skel" style="width:30%;height:9px;margin-top:auto"></div>
        </div>`,
      )}</div>
    </section>`;
  }

  private renderRoster(agents: AgentKnowledgeProfile[]) {
    if (!agents.length)
      return html`<section class="ga-panel roster-panel">${glassEmpty({
        title: this.query ? `No agents match “${this.query}”` : "No agents yet",
        sub: this.query
          ? "Try a shorter name, or clear the filter to see the whole fleet."
          : "Agents appear here as soon as the gateway reports them — add one from the Agents page.",
        action: this.query
          ? html`<button class="gt-btn" @click=${() => (this.query = "")}>Clear filter</button>`
          : html`<a class="gt-btn" href=${this.tabHref("agents")} @click=${(e: MouseEvent) => this.navigate(e, "agents")}>Open Agents</a>`,
      })}</section>`;
    return html`<section class="ga-panel roster-panel">
      <h2 class="ga-section-head">Roster <span class="count">${agents.length}</span></h2>
      <div class="roster" role="listbox" aria-label="Agents">
      ${agents.map((a, i) => {
        const sel = a.id === this.selectedId;
        return html`<button
          class="agent ga-card gt-rise ${sel ? "sel" : ""}"
          style="--gt-i:${Math.min(i, 12)}"
          role="option"
          aria-selected=${sel}
          data-agent=${a.id}
          @click=${() => this.select(a.id)}
        >
          <div class="agent__top">
            ${this.dot(a.activity.status)}
            <span class="agent__emoji">${sanitizeIdentityEmoji(a.emoji) || a.name.slice(0, 1).toUpperCase()}</span>
            <span class="agent__name">${a.name}</span>
            ${a.isDefault ? html`<span class="tag">default</span>` : nothing}
          </div>
          <div class="agent__model">${a.capabilities.type === "cli" ? `CLI · ${a.capabilities.cliCommand ?? "terminal"}` : shortModel(a.capabilities.model.primary)}</div>
          <div class="agent__badges">
            <span title="Tools allowed"><b>${a.badges.tools}</b> tools</span>
            <span title="Knowledge sources reachable"><b>${a.badges.sources}</b> sources</span>
            <span title="Skills enabled"><b>${formatCount(a.badges.skills)}</b> skills</span>
            <span title="Identity files present"><b>${a.badges.identityFiles}</b>/7 id</span>
          </div>
          <div class="agent__foot">${a.activity.runningNow ? html`<span class="live-txt">${a.activity.runningNow} running</span>` : formatAgo(a.activity.lastActiveAt, this.now)}</div>
        </button>`;
      })}
      </div>
    </section>`;
  }

  // ── Profile ─────────────────────────────────────────────────────────

  private renderProfile(a: AgentKnowledgeProfile) {
    const c = a.capabilities;
    return html`<article class="profile" data-profile=${a.id}>
      <header class="profile__head gt-glass">
        <span class="profile__emoji">${sanitizeIdentityEmoji(a.emoji) || a.name.slice(0, 1).toUpperCase()}</span>
        <div class="profile__title">
          <h3>${a.name} <code>${a.id}</code></h3>
          <p>
            ${a.department ? html`<span class="tag">${a.department}</span>` : nothing}
            <span class="status ${a.activity.status}">${this.dot(a.activity.status)}${a.activity.status}</span>
            ${a.description ?? (isIdentityTemplateHint(a.identity.persona.vibe) ? "" : a.identity.persona.vibe || "")}
          </p>
        </div>
        <div class="profile__kpis">
          ${this.kpi(c.tools.allowed, `of ${c.tools.total} tools`)}
          ${this.kpi(a.knowledge.filter((k) => k.reachable).length, `of ${a.knowledge.length} sources`)}
          ${this.kpi(a.activity.sessions, "sessions")}
        </div>
      </header>
      ${a.errors.length
        ? html`<details class="errors"><summary>${ICON.warn} ${a.errors.length} source${a.errors.length === 1 ? "" : "s"} could not be read</summary><ul>${a.errors.map((e) => html`<li>${e}</li>`)}</ul></details>`
        : nothing}
      <div class="cards">
        ${this.renderIdentity(a)} ${this.renderMemory(a)} ${this.renderSources(a)} ${this.renderCapabilities(a)}
        ${this.renderActivity(a)}
      </div>
    </article>`;
  }

  private kpi(v: number, label: string) {
    return html`<div class="kpi"><b>${formatCount(v)}</b><span>${label}</span></div>`;
  }

  private card(title: string, subtitle: string | TemplateResult, body: TemplateResult, cls = "") {
    return html`<section class="card ga-panel ${cls}">
      <header><h4>${title}</h4><span class="card__sub">${subtitle}</span></header>
      ${body}
    </section>`;
  }

  private renderIdentity(a: AgentKnowledgeProfile) {
    const id = a.identity;
    const persona = id.persona;
    return this.card(
      "Identity",
      `${id.present}/${id.total} files · ${formatAgo(id.lastUpdatedAt, this.now)}`,
      html`
        <div class="kv"><span>Workspace</span><code class="path" title=${id.workspace}>${id.workspace || "—"}</code></div>
        ${persona.name && !isIdentityTemplateHint(persona.name) ? html`<div class="kv"><span>Persona</span><b>${sanitizeIdentityEmoji(persona.emoji) ?? ""} ${persona.name}</b></div>` : nothing}
        ${persona.creature && !isIdentityTemplateHint(persona.creature) ? html`<p class="blurb">${persona.creature}</p>` : nothing}
        <ul class="files">
          ${id.files.map(
            (f) => html`<li>
              <button
                class="file ${f.exists ? "" : "missing"}"
                ?disabled=${!this.onOpenIdentity}
                title=${f.exists ? `Open ${f.name} in the identity editor` : `Create ${f.name} in the identity editor`}
                @click=${() => this.onOpenIdentity?.(a.id, f.name)}
              >
                <span class="reach ${f.exists ? "yes" : "no"}">${f.exists ? ICON.check : ICON.cross}</span>
                ${ICON.file}<span class="file__name">${f.name}</span>
                ${f.readOnly ? html`<span class="tag">read-only</span>` : nothing}
                <span class="file__meta">${f.exists ? `${formatBytes(f.size)} · ${formatAgo(f.updatedAt, this.now)}` : "missing"}</span>
              </button>
            </li>`,
          )}
        </ul>
      `,
    );
  }

  private renderMemory(a: AgentKnowledgeProfile) {
    const m = a.memory;
    const sov = m.sovereign;
    const sovCounts = Object.entries(sov.counts);
    return this.card(
      "Memory",
      m.vector.enabled ? `semantic index ${statusLabel(m.vector.status)}` : "semantic index off",
      html`
        <div class="mem">
          <div class="mem__row">
            <div class="mem__label">Semantic index <small>memory_search</small></div>
            ${this.pill(m.vector.status)} ${this.reach(m.vector.reachable, m.vector.reachable ? "agent can query it" : "no memory_search tool")}
          </div>
          <div class="mem__nums">
            ${this.num(m.vector.chunks, "chunks")} ${this.num(m.vector.files, "files")}
            ${Object.entries(m.vector.sources).map(([k, v]) => this.num(v.chunks, `${k} chunks`))}
            <span class="fresh ${freshness(m.vector.lastIndexedAt, this.now)}">${m.vector.lastIndexedAt ? `indexed ${formatAgo(m.vector.lastIndexedAt, this.now)}` : m.vector.enabled ? "not indexed yet" : "disabled"}</span>
          </div>
          ${m.vector.storePath ? html`<code class="path small" title=${m.vector.storePath}>${m.vector.provider ?? "auto"} · ${m.vector.storePath}</code>` : nothing}

          <div class="mem__row">
            <div class="mem__label">Notebook <small>MEMORY.md + daily notes</small></div>
            ${this.pill(m.notebook.status)}
          </div>
          <div class="mem__nums">
            ${html`<span class="num"><b>${formatBytes(m.notebook.memoryMdBytes)}</b><span>MEMORY.md</span></span>`}
            ${this.num(m.notebook.dailyFiles, "daily files")}
            <span class="fresh ${freshness(m.notebook.lastUpdatedAt, this.now)}">${formatAgo(m.notebook.lastUpdatedAt, this.now)}</span>
          </div>

          <div class="mem__row">
            <div class="mem__label">Transcripts</div>
            ${this.pill(m.transcripts.status)}
          </div>
          <div class="mem__nums">
            ${this.num(m.transcripts.sessions, "sessions")}
            <span class="note">${m.transcripts.indexedIntoMemory ? `${formatCount(m.transcripts.indexedChunks)} chunks ingested into memory` : "not ingested into the semantic index"}</span>
          </div>

          <div class="mem__row">
            <div class="mem__label">Sovereign Memory <small>shared · ${sov.url.replace(/^https?:\/\//, "")}</small></div>
            ${this.pill(sov.status)}
          </div>
          <div class="mem__nums">
            ${sovCounts.length
              ? sovCounts.map(([k, v]) => this.num(v ?? 0, k))
              : html`<span class="note">${sov.status === "offline" ? "service not running — beliefs, values, relationships and lessons unavailable" : "no counts reported"}</span>`}
          </div>
        </div>
      `,
    );
  }

  private renderSources(a: AgentKnowledgeProfile) {
    const reachable = a.knowledge.filter((k) => k.reachable).length;
    return this.card(
      "Knowledge sources",
      `${reachable} of ${a.knowledge.length} reachable`,
      html`<div class="sources" role="table">
        <div class="src src--head" role="row">
          <span>Source</span><span>Holds</span><span>Updated</span><span>Reach</span><span></span>
        </div>
        ${sortSources(mergeSources(this.data?.sourceDefs ?? [], a.knowledge)).map((k) => this.sourceRow(k))}
      </div>`,
      "wide",
    );
  }

  private sourceRow(k: SourceView) {
    const detail = k.detail ? Object.entries(k.detail).map(([n, v]) => `${formatCount(v)} ${n}`).join(" · ") : "";
    return html`<div class="src ${k.reachable ? "" : "off"}" role="row" data-source=${k.id}>
      <span class="src__name">
        <b>${k.label}</b>
        <small>${k.description}</small>
      </span>
      <span class="src__count">
        ${k.count !== null
          ? html`<b>${formatCount(k.count)}</b> <small>${k.countLabel ?? ""}</small>`
          : html`<small class="muted">${k.status === "ok" ? "live connector" : statusLabel(k.status)}</small>`}
        ${k.agentCount !== undefined && k.agentCount !== null
          ? html`<em class="mine">${formatCount(k.agentCount)} ${k.agentCountLabel}</em>`
          : nothing}
        ${detail ? html`<small class="muted detail">${detail}</small>` : nothing}
        ${k.note && k.status !== "ok" && k.status !== "empty" ? html`<small class="muted detail">${k.note}</small>` : nothing}
        ${k.defNote && k.reachable ? html`<small class="muted detail">${k.defNote}</small>` : nothing}
      </span>
      <span class="fresh ${freshness(k.lastUpdatedAt, this.now)}">${k.lastUpdatedAt ? formatAgo(k.lastUpdatedAt, this.now) : "—"}</span>
      <span class="src__reach" title=${k.reachable ? `via ${k.grantedBy.join(", ")}` : `needs one of: ${k.via.join(", ")}`}>
        ${this.reach(k.reachable, k.reachable ? k.grantedBy.join(", ") : `needs ${k.via[0]}`)}
      </span>
      <span>
        ${k.tab
          ? html`<a class="open" href=${this.tabHref(k.tab)} @click=${(e: MouseEvent) => this.navigate(e, k.tab!)} title="Open ${k.label}">${ICON.arrow}</a>`
          : nothing}
      </span>
    </div>`;
  }

  private renderCapabilities(a: AgentKnowledgeProfile) {
    const c = a.capabilities;
    const catalog = this.data?.tools ?? [];
    const byName = new Map(catalog.map((t) => [t.name, t]));
    const domains = c.tools.domains
      .map((d) => {
        const allowed = new Set(d.allowedTools);
        const list = this.showUnavailableTools
          ? catalog.filter((t) => t.domain === d.domain)
          : d.allowedTools.map((n) => byName.get(n) ?? { name: n, description: "", domain: d.domain });
        const tools = list
          .map((t) => ({ ...t, allowed: allowed.has(t.name) }))
          .sort((x, y) => Number(y.allowed) - Number(x.allowed) || x.name.localeCompare(y.name));
        return { ...d, tools };
      })
      .filter((d) => d.tools.length > 0);
    const skillByName = new Map((this.data?.skills ?? []).map((s) => [s.name, s]));
    const skills =
      c.skills.mode === "list"
        ? c.skills.enabled.map((n) => skillByName.get(n) ?? { name: n })
        : c.skills.mode === "all"
          ? (this.data?.skills ?? []).filter((s) => s.eligible !== false)
          : [];
    return this.card(
      "Capabilities",
      `${c.type === "cli" ? "CLI agent" : "native agent"}${c.tools.profile ? ` · profile ${c.tools.profile}` : ""}`,
      html`
        <div class="caps">
          <div class="caps__grid">
            <div class="kv"><span>Model</span><b>${c.type === "cli" ? (c.cliCommand ?? "cli") : (c.model.primary ?? "default")}</b></div>
            ${c.model.fallbacks.length ? html`<div class="kv"><span>Fallbacks</span><span class="chips">${c.model.fallbacks.map((f) => html`<code>${shortModel(f)}</code>`)}</span></div>` : nothing}
            <div class="kv"><span>Coder backend</span><b>${c.backend.primary}${c.backend.fallback ? ` → ${c.backend.fallback}` : ""}</b>${c.backend.explicit ? nothing : html`<small class="muted">inherited</small>`}</div>
            <div class="kv"><span>Sub-agents</span>
              ${c.subagents.canSpawn
                ? html`<b>can spawn</b> <span class="chips">${c.subagents.allowAgents.map((x) => html`<code>${x === "*" ? "any agent" : x}</code>`)}${c.subagents.coders.map((x) => html`<code>${x}</code>`)}</span>`
                : html`<span class="muted">cannot spawn</span>`}
            </div>
          </div>

          <div class="access">
            ${Object.entries(c.access).map(
              ([k, on]) => html`<span class="acc ${on ? "on" : ""}">${on ? ICON.check : ICON.cross}${ACCESS_LABELS[k] ?? k}</span>`,
            )}
          </div>

          ${c.tools.unknownAllowEntries.length
            ? html`<div class="warnline">${ICON.warn}<span>Allowlist entries that match no tool: ${c.tools.unknownAllowEntries.map((u) => html`<code>${u}</code>`)} — typos, missing <code>group:</code> prefix, or a plugin that isn't loaded.</span></div>`
            : nothing}

          <div class="sub-h">
            <h5>Tools <small>${c.tools.allowed} of ${c.tools.total} allowed</small></h5>
            <label class="toggle"><input type="checkbox" .checked=${this.showUnavailableTools} @change=${(e: Event) => (this.showUnavailableTools = (e.target as HTMLInputElement).checked)} /> show unavailable</label>
          </div>
          <div class="domains">
            ${domains.length
              ? domains.map(
                  (d) => html`<details class="domain" ?open=${d.allowed > 0 && d.allowed <= 6}>
                    <summary><span>${d.domain}</span><span class="bar"><i style="width:${d.total ? (d.allowed / d.total) * 100 : 0}%"></i></span><b>${d.allowed}/${d.total}</b></summary>
                    <ul>
                      ${d.tools.map(
                        (t) => html`<li class=${t.allowed ? "" : "off"}>
                          <span class="reach ${t.allowed ? "yes" : "no"}">${t.allowed ? ICON.check : ICON.cross}</span>
                          <code>${t.name}</code>
                          <span class="desc">${t.description || (t.core ? "Core runtime tool" : "")}</span>
                        </li>`,
                      )}
                    </ul>
                  </details>`,
                )
              : html`<p class="muted">No tools allowed.</p>`}
          </div>

          <div class="split">
            <div>
              <h5>Skills <small>${c.skills.mode === "all" ? `all eligible (${c.skills.catalogEligible} of ${c.skills.catalogTotal})` : c.skills.mode === "none" ? "none" : `${c.skills.count} enabled`}</small></h5>
              ${c.skills.mode === "list"
                ? html`<ul class="plain">${skills.map((s) => html`<li><code>${s.name}</code> <span class="desc">${s.description ?? (s.eligible === undefined ? "not installed on this node" : "")}</span></li>`)}</ul>`
                : c.skills.mode === "all"
                  ? html`<details class="more"><summary>Show ${skills.length} skills</summary><ul class="plain">${skills.map((s) => html`<li><code>${s.name}</code> <span class="desc">${s.description ?? ""}</span></li>`)}</ul></details>`
                  : nothing}
            </div>
            <div>
              <h5>MCP servers <small>${c.mcp.reachable ? (c.mcp.scoped ? "scoped" : "all") : "no mcp tool"}</small></h5>
              ${c.mcp.servers.length
                ? html`<ul class="plain">${c.mcp.servers.map((s) => html`<li class=${s.enabledForAgent ? "" : "off"}>${this.reach(s.enabledForAgent, "")}<code>${s.name}</code> <span class="desc">${s.toolCount} tools · ${s.status}${s.nodeName ? ` · ${s.nodeName}` : ""}</span></li>`)}</ul>`
                : html`<p class="muted">${c.mcp.status === "error" ? "MCP registry unavailable" : "No MCP servers connected"}</p>`}
            </div>
            <div>
              <h5>Channels</h5>
              ${c.channels.length
                ? html`<ul class="plain">${c.channels.map((ch) => html`<li><code>${ch.channel}</code> <span class="desc">${ch.source === "binding" ? `bound${ch.accountId ? ` · ${ch.accountId}` : ""}${ch.peer ? ` · ${ch.peer}` : ""}` : ch.source === "agent-bot" ? "own bot token" : "default route"}</span></li>`)}</ul>`
                : html`<p class="muted">No channel bindings — reached via sessions / sub-agent spawns.</p>`}
            </div>
            <div>
              <h5>Federation <small>${c.federation.role}</small></h5>
              <ul class="plain">${c.federation.nodes.map((n) => html`<li>${this.dot(n.online ? "active" : "dormant")}<code>${n.name}</code> <span class="desc">${n.local ? "this node" : n.isMaster ? "master" : "satellite"}</span></li>`)}</ul>
              ${c.federation.nodes.length > 1 ? html`<p class="note">${c.federation.canTargetRemote ? "Can dispatch work to remote nodes." : "Runs on this node only (no nodes / sessions_spawn tool)."}</p>` : nothing}
            </div>
          </div>
        </div>
      `,
      "wide",
    );
  }

  private renderActivity(a: AgentKnowledgeProfile) {
    const act = a.activity;
    const maxTool = Math.max(1, ...act.recentTools.map((t) => t.count));
    return this.card(
      "Activity",
      html`<span class="status ${act.status}">${this.dot(act.status)}${act.status}</span>`,
      html`
        <div class="mem__nums">
          ${this.num(act.runningNow, "running now")} ${this.num(act.sessionsLast24h, "sessions 24h")}
          ${this.num(act.sessions, "sessions")} ${this.num(act.totalTokens, "tokens")}
          <span class="fresh ${freshness(act.lastActiveAt, this.now)}">last active ${formatAgo(act.lastActiveAt, this.now)}</span>
        </div>
        ${act.runs.length
          ? html`<h5>Sub-agent runs</h5><ul class="plain runs">${act.runs.map((r) => html`<li>${this.dot(r.state === "running" ? "running" : "idle")}<span class="run__label">${r.label}</span><span class="desc">${r.state} · ${formatAgo(r.startedAt, this.now)}</span></li>`)}</ul>`
          : nothing}
        <h5>Recent tool use <small>latest transcripts</small></h5>
        ${act.recentTools.length
          ? html`<ul class="bars">${act.recentTools.map((t) => html`<li><code>${t.name}</code><span class="bar"><i style="width:${(t.count / maxTool) * 100}%"></i></span><b>${t.count}</b></li>`)}</ul>`
          : html`<p class="muted">No tool calls in recent transcripts.</p>`}
      `,
    );
  }

  // ── Matrix ──────────────────────────────────────────────────────────

  private renderMatrix(agents: AgentKnowledgeProfile[]) {
    const data = this.data!;
    const max = domainMaxima(data);
    const domains = data.domains;
    if (!agents.length) return this.renderRoster(agents);
    return html`<section class="matrix-wrap ga-panel" aria-label="Capability matrix">
      <h2 class="ga-section-head">Capability matrix <span class="count">${agents.length}</span></h2>
      <p class="note">Allowed tools per capability domain. Brighter = more of that domain than other agents. Click a row for the full profile.</p>
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr>
              <th class="sticky">Agent</th>
              ${domains.map((d) => html`<th><span>${d}</span></th>`)}
              <th><span>Sources</span></th>
              <th><span>Skills</span></th>
              <th><span>Identity</span></th>
            </tr>
          </thead>
          <tbody>
            ${agents.map(
              (a) => html`<tr data-agent=${a.id} @click=${() => this.select(a.id)} class=${a.id === this.selectedId ? "sel" : ""}>
                <th class="sticky" scope="row">${this.dot(a.activity.status)}${sanitizeIdentityEmoji(a.emoji) ? html`<span class="m-emoji">${sanitizeIdentityEmoji(a.emoji)}</span>` : nothing}${a.name}</th>
                ${domains.map((d) => {
                  const v = a.matrix[d] ?? 0;
                  const k = cellIntensity(v, max[d] ?? 0);
                  return html`<td class=${v ? "" : "zero"} style="--k:${k}" title="${a.name} · ${d}: ${v} tool${v === 1 ? "" : "s"}">${v || "·"}</td>`;
                })}
                <td class="n">${a.badges.sources}</td>
                <td class="n">${formatCount(a.badges.skills)}</td>
                <td class="n">${a.badges.identityFiles}/7</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  // ── Bits ────────────────────────────────────────────────────────────

  /** Live status light (running pulses). */
  private dot(status: string) {
    const st = status === "running" ? "ok" : status === "active" ? "gold" : "idle";
    return html`<span class="gt-light dot ${status}" data-state=${st} ?data-pulse=${status === "running"} title=${status}></span>`;
  }

  private pill(status: string) {
    return html`<span class="pill ${status}">${statusLabel(status)}</span>`;
  }

  private reach(ok: boolean, label: string) {
    return html`<span class="reach ${ok ? "yes" : "no"}">${ok ? ICON.check : ICON.cross}${label ? html`<span>${label}</span>` : nothing}</span>`;
  }

  private num(v: number, label: string) {
    return html`<span class="num"><b>${formatCount(v)}</b><span>${label}</span></span>`;
  }

  static styles = [
    GLASS_AGENTS_SHADOW_CSS,
    css`
    :host {
      display: block;
      font-size: 13px;
      container-type: inline-size;
    }
    * { box-sizing: border-box; }
    h1, h2, h3, h4, h5, p { margin: 0; }
    .ma {
      --ma-ok: var(--ok, #22c55e);
      --ma-warn: var(--warn, #f59e0b);
      --ma-danger: var(--danger, #ef4444);
      --ma-line-gold: color-mix(in srgb, var(--gt-gold) 22%, transparent);
      --ma-well: color-mix(in srgb, var(--gt-fg) 3%, transparent);
      color: var(--gt-fg);
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding-bottom: 24px;
    }
    .ma code { font-family: var(--glass-font-mono, var(--mono, ui-monospace, monospace)); font-size: 11.5px; }
    .ma button { font: inherit; color: inherit; text-transform: none; letter-spacing: normal; }
    .ma .muted { color: var(--gt-dim); }
    .ma .note { color: var(--gt-dim); font-size: 12px; }
    .ma .tag {
      display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px;
      font: 600 9.5px/1 var(--glass-font-mono, var(--mono)); letter-spacing: .08em; text-transform: uppercase;
      color: var(--gt-gold-ink); border: 1px solid var(--ma-line-gold); background: var(--gt-gold-faint);
    }
    .ma .gt-hero { padding-bottom: 6px; }
    .ma-hero__copy { min-width: 0; flex: 1 1 360px; }
    .ma .gt-stat-value { display: inline-flex; align-items: center; gap: 8px; }
    .ma .stat.live .gt-stat-value { color: var(--ma-ok); }
    .ma .stat.warn .gt-stat-value { color: var(--ma-warn); }
    .ma .ga-section-head .count { font-variant-numeric: tabular-nums; color: var(--gt-faint); letter-spacing: .08em; }

    /* Toolbar */
    .ma-bar { gap: 10px; }
    .ma .gt-seg button[aria-selected="true"] {
      color: var(--gt-fg);
      background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 40%, transparent), 0 4px 14px -6px color-mix(in srgb, var(--gt-gold) 60%, transparent);
    }
    .ma .gt-seg button { min-height: 30px; box-sizing: border-box; display: inline-flex; align-items: center; }
    .ma .search { flex: 1 1 180px; max-width: 300px; min-width: 0; }
    .ma .search::-webkit-search-cancel-button { filter: grayscale(1); opacity: .6; }
    .ma .updated { display: inline-flex; align-items: center; gap: 8px; color: var(--gt-dim); font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
    .ma .updated .gt-light { width: 7px; height: 7px; }
    .ma .icon-btn { width: 36px; padding: 0; color: var(--gt-gold-ink); }
    .ma .icon-btn svg { transition: transform 500ms var(--gt-ease); }
    .ma .icon-btn:hover svg { transform: rotate(140deg); }
    .ma .banner {
      display: flex; gap: 10px; align-items: center; padding: 11px 14px; border-radius: var(--gt-radius-sm);
      border: 1px solid color-mix(in srgb, var(--ma-warn) 35%, transparent);
      background: color-mix(in srgb, var(--ma-warn) 9%, transparent); color: var(--ma-warn);
    }
    .ma .gt-empty { padding: 36px 16px; }

    /* Status lights */
    .ma .dot { width: 7px; height: 7px; }
    .ma .dot.dormant { opacity: .55; box-shadow: none; }
    .ma .status { display: inline-flex; align-items: center; gap: 7px; text-transform: capitalize; font-size: 12px; color: var(--gt-dim); }
    .ma .status.running { color: var(--ma-ok); }
    .ma .status.active { color: var(--gt-gold-ink); }

    /* Roster */
    .roster { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 10px; }
    .ma .agent {
      text-align: left; cursor: pointer; padding: 12px 13px; min-height: 112px; min-width: 0;
      display: flex; flex-direction: column; gap: 6px;
      transition: transform 420ms var(--glass-spring, var(--gt-ease)), border-color 220ms ease, box-shadow 420ms var(--gt-ease), background 220ms ease;
    }
    .ma .agent:hover { transform: translateY(-3px); }
    .ma .agent:active { transform: translateY(-1px) scale(.985); transition-duration: 120ms; }
    .ma .agent:focus-visible { outline: none; box-shadow: var(--gt-focus); }
    .ma .agent.sel {
      border-color: color-mix(in srgb, var(--gt-gold) 70%, transparent);
      background: linear-gradient(160deg, color-mix(in srgb, var(--gt-gold) 16%, transparent), color-mix(in srgb, var(--gt-gold) 4%, transparent) 60%);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent), 0 0 0 1px color-mix(in srgb, var(--gt-gold) 28%, transparent), 0 16px 36px -18px color-mix(in srgb, var(--gt-gold) 70%, transparent);
    }
    .ma .agent.skeleton { cursor: default; border: 1px solid var(--gt-line); border-radius: var(--gt-radius-sm); background: var(--ma-well); }
    .agent__top { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .agent__emoji {
      width: 24px; height: 24px; display: grid; place-items: center; border-radius: 8px; flex: none; font-size: 13px; font-weight: 650;
      color: var(--gt-gold-ink);
      background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 30%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent) 75%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 28%, transparent);
    }
    .agent__name { font-weight: 620; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .agent__model { font-family: var(--glass-font-mono, var(--mono, monospace)); font-size: 11px; color: var(--gt-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent__badges { display: flex; flex-wrap: wrap; gap: 3px 9px; font-size: 11px; color: var(--gt-dim); }
    .agent__badges b { color: var(--gt-fg); font-weight: 620; font-variant-numeric: tabular-nums; }
    .agent__foot { margin-top: auto; font-size: 11px; color: var(--gt-faint); }
    .live-txt { color: var(--ma-ok); }

    /* Profile */
    .profile { scroll-margin-top: 12px; display: flex; flex-direction: column; gap: 12px; }
    .ma .profile__head {
      display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: center; padding: 16px 18px;
      background: radial-gradient(120% 160% at 0% 0%, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent 60%), var(--gt-surface);
    }
    .profile__emoji {
      width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; font-size: 26px; font-weight: 650;
      color: var(--gt-gold-ink);
      background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 34%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 72%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 34%, transparent), 0 14px 32px -16px color-mix(in srgb, var(--gt-gold) 70%, transparent);
    }
    .profile__title { min-width: 0; }
    .profile__title h3 { font-size: 20px; font-weight: 650; letter-spacing: -.02em; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .profile__title h3 code { color: var(--gt-faint); font-weight: 400; }
    .profile__title p { margin-top: 6px; color: var(--gt-dim); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; line-height: 1.45; }
    .profile__kpis { display: flex; gap: 4px; }
    .kpi { text-align: right; padding: 4px 14px; border-left: 1px solid var(--gt-line); }
    .kpi b { display: block; font-size: 22px; font-weight: 650; letter-spacing: -.02em; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
    .kpi span { font: 500 10px/1 var(--glass-font-mono, var(--mono)); color: var(--gt-faint); text-transform: uppercase; letter-spacing: .12em; }
    .ma .errors { font-size: 12px; color: var(--ma-warn); }
    .ma .errors summary { cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
    .ma .errors ul { margin: 6px 0 0; padding-left: 18px; color: var(--gt-dim); font-family: var(--glass-font-mono, var(--mono)); font-size: 11px; }

    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .ma .card { min-width: 0; }
    .card.wide { grid-column: 1 / -1; }
    .card > header { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--gt-line); flex-wrap: wrap; }
    .card h4 { font: 600 10.5px/1 var(--glass-font-mono, var(--mono)); letter-spacing: .2em; text-transform: uppercase; color: var(--gt-gold-ink); }
    .card__sub { font-size: 12px; color: var(--gt-dim); }
    .ma h5 { font: 600 10px/1.3 var(--glass-font-mono, var(--mono)); letter-spacing: .14em; text-transform: uppercase; color: var(--gt-gold-ink); margin: 14px 0 8px; }
    .ma h5 small, .mem__label small { font-family: var(--glass-font, inherit); text-transform: none; letter-spacing: 0; color: var(--gt-faint); font-weight: 400; margin-left: 4px; }

    .kv { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; min-width: 0; flex-wrap: wrap; }
    .kv > span:first-child { color: var(--gt-dim); min-width: 96px; font-size: 12px; }
    .kv b { font-weight: 600; overflow-wrap: anywhere; }
    .path { color: var(--gt-gold-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; display: inline-block; vertical-align: bottom; }
    .path.small { font-size: 10.5px; color: var(--gt-faint); margin: 2px 0 6px; }
    .blurb { color: var(--gt-dim); font-size: 12px; margin: 4px 0 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
    .chips code { padding: 2px 7px; border-radius: 7px; background: var(--ma-well); border: 1px solid var(--gt-line); }

    .files { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 4px; }
    .file {
      width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 10px; min-height: 36px; border-radius: 10px; cursor: pointer; min-width: 0;
      border: 1px solid transparent; background: var(--ma-well); text-align: left; color: var(--gt-fg);
      transition: border-color 200ms ease, background 200ms ease, transform 160ms ease;
    }
    .file:hover:not([disabled]) { border-color: var(--ma-line-gold); background: var(--gt-gold-faint); }
    .file:active:not([disabled]) { transform: scale(.99); }
    .file:focus-visible { outline: none; box-shadow: var(--gt-focus); }
    .file.missing { opacity: .6; }
    .file svg { flex: none; color: var(--gt-faint); }
    .file__name { font-family: var(--glass-font-mono, var(--mono, monospace)); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file__meta { margin-left: auto; font-size: 11px; color: var(--gt-faint); white-space: nowrap; }

    .reach { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; }
    .reach.yes { color: var(--ma-ok); }
    .reach.no { color: var(--gt-faint); }
    .reach span { overflow-wrap: anywhere; }
    .pill {
      display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px;
      font: 600 9.5px/1 var(--glass-font-mono, var(--mono)); text-transform: uppercase; letter-spacing: .1em;
      border: 1px solid var(--gt-line); color: var(--gt-dim); background: var(--ma-well);
    }
    .pill.ok { color: var(--ma-ok); border-color: color-mix(in srgb, var(--ma-ok) 32%, transparent); background: color-mix(in srgb, var(--ma-ok) 9%, transparent); }
    .pill.empty { color: var(--gt-gold-ink); border-color: var(--ma-line-gold); background: var(--gt-gold-faint); }
    .pill.offline, .pill.error { color: var(--ma-danger); border-color: color-mix(in srgb, var(--ma-danger) 32%, transparent); background: color-mix(in srgb, var(--ma-danger) 8%, transparent); }

    .mem__row { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--gt-line); flex-wrap: wrap; }
    .mem__row:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
    .mem__label { font-weight: 600; margin-right: auto; }
    .mem__nums { display: flex; gap: 6px 16px; flex-wrap: wrap; align-items: baseline; margin-top: 6px; }
    .num { display: inline-flex; gap: 5px; align-items: baseline; }
    .num b { font-size: 16px; font-weight: 650; letter-spacing: -.01em; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
    .num span { font-size: 11.5px; color: var(--gt-dim); }
    .fresh { font-size: 11.5px; }
    .fresh.live { color: var(--ma-ok); }
    .fresh.fresh { color: var(--gt-gold-ink); }
    .fresh.stale { color: var(--gt-dim); }
    .fresh.cold { color: var(--gt-faint); }

    /* Sources table */
    .sources { display: grid; gap: 2px; }
    .src { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(140px, 1.4fr) 92px minmax(120px, 1fr) 30px; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 10px; transition: background 180ms ease; }
    .src:not(.src--head):hover { background: var(--gt-gold-faint); }
    .src--head { font: 500 10px/1 var(--glass-font-mono, var(--mono)); text-transform: uppercase; letter-spacing: .14em; color: var(--gt-faint); padding-bottom: 6px; }
    .src.off .src__name b, .src.off .src__count b { color: var(--gt-faint); }
    .src__name { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
    .src__name b { font-weight: 600; }
    .src__name small { color: var(--gt-faint); font-size: 11px; }
    .src__count { display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; min-width: 0; }
    .src__count b { font-size: 14px; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
    .src__count small { color: var(--gt-dim); font-size: 11px; }
    .src__count .detail { flex-basis: 100%; }
    .mine { font-style: normal; font-size: 11px; color: var(--gt-gold-ink); padding: 0 7px; border-radius: 999px; background: var(--gt-gold-faint); border: 1px solid var(--ma-line-gold); }
    .open {
      display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--gt-gold-ink); border: 1px solid var(--gt-line);
      transition: background 180ms ease, border-color 180ms ease, transform 160ms ease;
    }
    .open:hover { background: var(--gt-gold-faint); border-color: var(--ma-line-gold); transform: translateX(2px); }
    .open:focus-visible { outline: none; box-shadow: var(--gt-focus); }

    /* Capabilities */
    .caps__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
    .access { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .acc { display: inline-flex; gap: 5px; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--gt-line); color: var(--gt-faint); }
    .acc.on { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 36%, transparent); background: var(--gt-gold-faint); }
    .acc.on svg { color: var(--ma-ok); }
    .warnline { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; padding: 9px 12px; border-radius: 10px; font-size: 12px; color: var(--ma-warn); background: color-mix(in srgb, var(--ma-warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--ma-warn) 28%, transparent); }
    .warnline > span { min-width: 0; overflow-wrap: anywhere; }
    .warnline code { display: inline-block; margin: 0 6px 0 0; overflow-wrap: anywhere; }
    .sub-h { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .toggle { font-size: 12px; color: var(--gt-dim); display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    .toggle input { accent-color: var(--gt-gold); }
    .domains { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; align-items: start; }
    .domain { border: 1px solid var(--gt-line); border-radius: 12px; background: var(--ma-well); transition: border-color 200ms ease; }
    .domain[open] { border-color: var(--ma-line-gold); }
    .domain summary { display: grid; grid-template-columns: 1fr 70px auto; gap: 10px; align-items: center; padding: 8px 12px; cursor: pointer; list-style: none; min-height: 36px; border-radius: 12px; }
    .domain summary:focus-visible { outline: none; box-shadow: var(--gt-focus); }
    .domain summary::-webkit-details-marker { display: none; }
    .domain summary b { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--gt-fg); }
    .bar { height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--gt-fg) 8%, transparent); overflow: hidden; display: block; }
    .bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 55%, transparent), var(--gt-gold)); }
    .domain ul { list-style: none; margin: 0; padding: 0 12px 10px; display: grid; gap: 4px; }
    .domain li { display: grid; grid-template-columns: 14px auto 1fr; gap: 6px; align-items: baseline; font-size: 12px; }
    .domain li.off { opacity: .55; }
    .domain li code, ul.plain li code { color: var(--gt-gold-ink); }
    .desc { color: var(--gt-dim); font-size: 11.5px; overflow-wrap: anywhere; }
    .split { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin-top: 4px; }
    ul.plain { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
    ul.plain li { font-size: 12px; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
    ul.plain li .dot { align-self: center; }
    ul.plain li.off { opacity: .5; }
    .more summary { cursor: pointer; font-size: 12px; color: var(--gt-gold-ink); margin-bottom: 6px; }
    .more ul { max-height: 240px; overflow: auto; }
    .runs li { flex-wrap: nowrap; }
    .run__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ul.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    ul.bars li { display: grid; grid-template-columns: minmax(90px, 140px) 1fr 32px; gap: 8px; align-items: center; font-size: 12px; }
    ul.bars li b { text-align: right; font-variant-numeric: tabular-nums; color: var(--gt-fg); }
    ul.bars code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Matrix */
    .matrix-wrap .note { margin-bottom: 10px; }
    .matrix-scroll { overflow: auto; border: 1px solid var(--gt-line); border-radius: var(--gt-radius-sm); background: var(--gt-surface-solid); max-height: 72vh; }
    table.matrix { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
    .matrix thead th { position: sticky; top: 0; z-index: 2; background: var(--gt-surface-solid); height: 118px; vertical-align: bottom; padding: 6px 4px; border-bottom: 1px solid var(--ma-line-gold); font-weight: 500; color: var(--gt-dim); }
    .matrix thead th span { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-size: 11px; letter-spacing: .03em; }
    .matrix thead th.sticky { left: 0; z-index: 3; text-align: left; vertical-align: bottom; font: 500 10px/1 var(--glass-font-mono, var(--mono)); text-transform: uppercase; letter-spacing: .14em; padding: 0 12px 8px; }
    .matrix tbody th { position: sticky; left: 0; z-index: 1; background: var(--gt-surface-solid); text-align: left; font-weight: 550; padding: 6px 12px; white-space: nowrap; border-right: 1px solid var(--gt-line); display: flex; gap: 8px; align-items: center; min-height: 34px; }
    .m-emoji { font-size: 12px; }
    .matrix tbody tr { cursor: pointer; }
    .matrix tbody tr:hover th, .matrix tbody tr.sel th { color: var(--gt-gold-ink); background: color-mix(in srgb, var(--gt-gold) 9%, var(--gt-surface-solid)); }
    .matrix td {
      text-align: center; padding: 0; min-width: 38px; height: 34px; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--gt-line);
      background: color-mix(in srgb, var(--gt-gold) calc(var(--k, 0) * 60%), transparent); color: var(--gt-fg);
      transition: filter 160ms ease;
    }
    .matrix tbody tr:hover td { filter: brightness(1.15); }
    .matrix td.zero { color: var(--gt-faint); background: transparent; }
    .matrix td.n { background: transparent; color: var(--gt-gold-ink); }
    .matrix tbody tr.sel td { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--gt-gold) 50%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--gt-gold) 50%, transparent); }

    /* Light theme touches */
    :host-context([data-theme="light"]) .ma { --ma-well: color-mix(in srgb, var(--gt-fg) 3.5%, #fff); }
    :host-context([data-theme="light"]) .ma .agent.sel { background: linear-gradient(160deg, color-mix(in srgb, var(--gt-gold) 18%, #fff), #fff 70%); }
    :host-context([data-theme="light"]) .ma .ga-card { background: rgba(255, 255, 255, 0.72); box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(24, 24, 27, 0.05); }

    /* Responsive */
    @container (max-width: 1100px) {
      .split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @container (max-width: 820px) {
      .cards { grid-template-columns: 1fr; }
      .domains, .caps__grid { grid-template-columns: 1fr; }
      .src { grid-template-columns: minmax(0, 1fr) auto 30px; grid-template-areas: "name reach open" "count count count" "fresh fresh fresh"; row-gap: 3px; }
      .src--head { display: none; }
      .src__name { grid-area: name; }
      .src__count { grid-area: count; }
      .src > .fresh { grid-area: fresh; }
      .src__reach { grid-area: reach; }
      .src > span:last-child { grid-area: open; }
    }
    @container (max-width: 520px) {
      .ma .gt-title { font-size: 28px; }
      .ma .gt-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .ma .gt-stat-label { font-size: 9px; letter-spacing: .08em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .roster { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .ma .agent { min-height: 100px; padding: 10px; }
      .agent__top { flex-wrap: wrap; row-gap: 4px; }
      .agent__name { flex: 1 1 72px; }
      .agent__badges { gap: 2px 6px; font-size: 10.5px; }
      .ma .profile__head { grid-template-columns: auto 1fr; padding: 14px; gap: 12px; }
      .profile__kpis { grid-column: 1 / -1; justify-content: space-between; }
      .kpi { text-align: left; border-left: 0; padding: 0; }
      .split { grid-template-columns: 1fr; }
      .ma .search { max-width: none; flex-basis: 100%; order: 3; }
      .ma .updated { margin-left: auto; }
      .kv > span:first-child { min-width: 82px; }
      .file__meta { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ma .agent, .file, .open, .matrix td, .ma .icon-btn svg { transition: none !important; }
      .ma .agent:hover, .ma .agent:active, .open:hover { transform: none; }
    }
  `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "memory-agents-view": MemoryAgentsView;
  }
}

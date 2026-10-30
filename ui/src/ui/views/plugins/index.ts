/**
 * Setup › Plugins — marketplace-style browse grid + store-listing detail page
 * for every installed plugin.
 *
 * Browse (default): hero + search, All / Installed / Enabled / Available,
 * category + trust-tier chips, sort, grid/list toggle. Cards show the
 * listing cover (or a generated InfiniBot cover), monogram/icon, tagline,
 * category, tier, version, publisher, status and one primary action
 * (Enable / Open / Set up / Configure). No ratings, installs or reviews are
 * shown: there is no registry data for them yet (hooks: PluginSummary.listing).
 *
 * Detail = a scrolling store listing with a sticky section nav: hero, facts,
 * screenshot gallery (lightbox), markdown description, "What it adds"
 * (live/saved contribution toggles), permissions (plain English + risk,
 * grant/revoke with cascade), settings (schema form, write-only secrets,
 * sticky save bar with the diff), appearance (live light/dark preview),
 * health & logs, data, versions and uninstall.
 *
 * What restarts the gateway, and is confirmed first (with a warning when
 * sub-agents are running): turning a plugin on/off, saving its settings,
 * full reload, uninstall. Everything else applies live.
 *
 * Deep link: /plugins?plugin=<id>&ptab=<section>.
 */

import "../../components/kv-connect.js";
import "../../components/kv-connect-card.js";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { getGatewayClient } from "../../gateway-client.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import type { AppViewState } from "../../app-view-state.js";
import type { Tab } from "../../navigation.js";
import { toSanitizedMarkdownHtml } from "../../markdown.js";
import { currentThemeName, pluginScopeInlineStyle, syncPluginHost } from "../../plugin-host.js";
import {
  TIER_LABELS,
  errorMessage,
  formatBytes,
  formatTime,
  monogramOf,
  type ConfigPayload,
  type ContributionState,
  type PermissionState,
  type PluginDetail,
  type PluginHealth,
  type PluginLogLine,
  type PluginSummary,
  type ResolvedAppearance,
} from "./api.js";
import { renderConfigForm, setPath } from "./config-form.js";
import { gatewayImageSrc } from "../../gateway-image";
import { renderPluginSettingsSections } from "../../components/plugin-settings-sections.js";
import { generatedCover } from "./covers.js";
import { renderCardIcon, renderCardSkeletons, renderDetailHero, renderGallery, renderPluginCard, type CardIcon } from "./card.js";
import {
  DEFAULT_QUERY,
  DETAIL_SECTIONS,
  FILTERS,
  RISK_LABEL,
  SORTS,
  applyPlanChannelLocks,
  applyQuery,
  accessBlock,
  cardStatus,
  cloudBlock,
  cloudSelfHostFeatures,
  categoryLabel,
  categoryOf,
  configChanges,
  describePermission,
  filterCounts,
  formatDate,
  groupSections,
  isDefaultQuery,
  isDefaultOffPermission,
  isDetailSection,
  isInstalled,
  permissionStatusLabel,
  permissionSummary,
  presentCategories,
  primaryAction,
  sortPermissionsByRisk,
  tierOf,
  type BrowseQuery,
  type DetailSectionId,
  type PrimaryAction,
  type Tier,
} from "./model.js";
import { PLUGINS_STYLES } from "./styles.js";
import { guidedState, loadGuidedCatalog, subscribeGuided } from "../../../learn/guided/catalog-store.js";
import { startTrack } from "../../../learn/guided/engine.js";
import { MARKET_STYLES } from "./market-styles.js";
import { PACKAGE_STYLES } from "./package-styles.js";
import { parseInstallLink, PluginPackages } from "./packages.js";
import {
  loadCloudPricing,
  paidGate,
  vaultForPlugin,
  vaultOffer,
  VAULT_DOWNLOADS_ACTION,
  VAULT_INCLUDED_LABEL,
  VAULT_UNLOCK_ACTION,
  type CloudPricing,
  type PaidGate,
} from "./cloud-pricing.js";
import { kinglyVaultUrls } from "../../marketplace/kinglyvault.js";
import { isCloudBuild } from "../../cloud/cloud-env.js";
import { PLAN_CHANNELS_EVENT, channelUpgradeCta, channelsExcluded } from "../../cloud/plan-channels.js";
import { openUpgrade } from "../../cloud/upgrade.js";
import { getClerkToken } from "../../saas-clerk.js";
import { marketplaceApiBase } from "../../marketplace/marketplace-api.js";
import { PluginPurchases } from "./purchases.js";
import { PURCHASE_STYLES } from "./purchase-styles.js";

type Note = { text: string; kind?: "ok" | "warn" | "err" };
type Modal =
  | { kind: "enable"; plugin: PluginSummary; enabled: boolean }
  | { kind: "config"; values: Record<string, unknown> }
  | { kind: "permission"; perm: PermissionState; granted: boolean }
  | { kind: "reload" }
  | { kind: "clear" }
  | { kind: "uninstall"; keepData: boolean };

type AppearanceDraft = Record<string, unknown>;
type Lightbox = { images: { src: string; caption?: string }[]; index: number; plugin: string };

const ACCENT_TOKENS = ["primary", "accent", "info", "success", "warning", "danger"] as const;
const TOKEN_SWATCH: Record<string, string> = {
  primary: "#fbbf24",
  accent: "#a855f7",
  info: "#38bdf8",
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
};
const DONE_STATES = new Set(["completed", "done", "failed", "error", "killed", "cancelled", "timeout", "stopped"]);
const LAYOUT_KEY = "infinibot.plugins.layout.v1";
const TIERS: Tier[] = ["first-party", "verified", "community"];

/** Fallback plural for a contribution kind label ("Nav entry" → "Nav entries", "Page" → "Pages"). */
export function pluralizeKindLabel(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(label)) return `${label}es`;
  return `${label}s`;
}

function httpBaseFromWsUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return "";
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Small inline glyphs (InfiniBot line icons — no third-party marks). */
const ICONS: Record<string, TemplateResult> = {
  search: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  grid: html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  list: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>`,
  back: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  close: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  prev: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  next: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
  ext: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  shield: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>`,
  warn: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17v.5"/></svg>`,
  puzzle: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4z"/></svg>`,
};

const KIND_ICON: Record<string, string> = {
  nav: "▤",
  page: "▢",
  rpc: "⇄",
  http: "↗",
  tool: "⚒",
  service: "◉",
  cron: "◷",
  agent: "◎",
  skill: "✦",
  mcp: "⌘",
  widget: "▦",
  channel: "✉",
};

@customElement("plugins-view")
export class PluginsView extends LitElement {
  static styles = [PLUGINS_STYLES, MARKET_STYLES, PACKAGE_STYLES, PURCHASE_STYLES];

  state: AppViewState | null = null;
  client: GatewayBrowserClient | null = null;

  @state() private plugins: PluginSummary[] = [];
  /** plugins.list as the gateway sent it (plan channel locks are applied on top). */
  private rawPlugins: PluginSummary[] = [];
  @state() private loaded = false;
  @state() private query: BrowseQuery = { ...DEFAULT_QUERY };
  @state() private layout: "grid" | "list" = "grid";
  @state() private selectedId: string | null = null;
  @state() private section: DetailSectionId = "overview";
  @state() private detail: PluginDetail | null = null;
  @state() private detailError: string | null = null;
  @state() private health: PluginHealth | null = null;
  @state() private logs: PluginLogLine[] = [];
  @state() private config: ConfigPayload | null = null;
  @state() private configDraft: Record<string, unknown> = {};
  @state() private appearanceDraft: AppearanceDraft = {};
  @state() private appearancePreview: ResolvedAppearance | null = null;
  @state() private appearanceDirty = false;
  @state() private busy = new Set<string>();
  @state() private notes = new Map<string, Note>();
  /** Plugin whose landing page is the start page (plugins.landing). */
  @state() private landingPluginId: string | null = null;
  @state() private pending = new Map<string, boolean>();
  @state() private modal: Modal | null = null;
  @state() private lightbox: Lightbox | null = null;
  @state() private runningSubagents: number | null = null;
  @state() private uninstallKeepData = true;
  @state() private dataImportMode: "merge" | "replace" = "merge";
  @state() private brokenImages = new Set<string>();
  /** Hosted cloud only: marketplace pricing + what this member owns (null = unknown → Enable as before). */
  @state() private pricing: CloudPricing | null = null;

  /** Zip import, permission review, Marketplace tab, updates and rollback. */
  private readonly pk = new PluginPackages({
    rpc: (method, params) => this.rpc(method, params),
    update: () => this.requestUpdate(),
    refresh: async () => {
      await this.refresh();
      if (this.selectedId) await this.loadDetail();
    },
    open: (id) => void this.select(id),
    plugins: () => this.plugins,
    runningSubagents: () => this.runningSubagents,
    countSubagents: () => void this.countRunningSubagents(),
    // KinglyVault CEO plan labels + links: hosted cloud only (the plan is sold and checked on KinglyVault).
    vault: (e) => (isCloudBuild() ? vaultOffer(e) : null),
    markdown: (md) => unsafeHTML(toSanitizedMarkdownHtml(md)),
    openLightbox: (id, images, index, from) => this.openLightbox(id, images, index, from),
    scrollTop: () => void this.updateComplete.then(() => this.scroller()?.scrollTo({ top: 0 })),
    buy: (id) => void this.pu.buy(id),
    client: () => this.gwClient(),
  });

  /** Paid plugins: catalog extras, KinglyVault purchases, Buy / Restore. */
  private readonly pu = new PluginPurchases({
    rpc: (method, params) => this.rpc(method, params),
    update: () => this.requestUpdate(),
    refresh: () => this.refresh(),
    plugins: () => this.plugins,
    open: (id) => {
      this.pk.setTab("installed");
      void this.select(id);
    },
    client: () => this.gwClient(),
  });

  private pendingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private themeObserver: MutationObserver | null = null;
  /** Detaches the scroll-spy listener. */
  private sectionObserver: (() => void) | null = null;
  private mountedPanel: { cleanup?: () => void } | null = null;
  private pendingScroll: DetailSectionId | null = null;
  private spyLocked = false;
  private returnFocus: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  gwClient(): GatewayBrowserClient | null {
    return this.client ?? this.state?.client ?? getGatewayClient();
  }

  private unsubGuided?: () => void;

  /** The plugin's first guided Learn track (only while it is enabled + loaded). */
  private tourTrackOf(p: PluginSummary): string | undefined {
    if (!p.enabled || p.status !== "loaded") return undefined;
    const fromCatalog = guidedState().plugins.find((x) => x.id === p.id)?.trackIds[0];
    if (fromCatalog) return fromCatalog;
    const learn = (p.contributes as { learn?: { tracks?: { id: string }[] } } | undefined)?.learn;
    return learn?.tracks?.[0]?.id;
  }

  private renderTourButton(p: PluginSummary, size: "sm" | "lg" = "sm") {
    const trackId = this.tourTrackOf(p);
    if (!trackId) return nothing;
    return html`<button
      class="pm-tour ${size}"
      data-plugin-tour=${p.id}
      data-learn-id=${`plugin-tour-${p.id}`}
      title=${`Guided walkthrough of ${p.name}`}
      aria-label=${`Take the tour of ${p.name}`}
      @click=${(e: Event) => {
        e.stopPropagation();
        void startTrack(trackId);
      }}
    ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 9 12 4 2 9l10 5 10-5Z" /><path d="M6 11.5V17c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5v-5.5" /></svg><span>Take the tour</span></button>`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubGuided = subscribeGuided(() => this.requestUpdate());
    void loadGuidedCatalog(getGatewayClient());
    const params = new URLSearchParams(window.location.search);
    const wantPlugin = params.get("plugin");
    const wantSection = params.get("ptab");
    if (wantPlugin) this.selectedId = wantPlugin;
    if (isDetailSection(wantSection)) {
      this.section = wantSection;
      this.pendingScroll = wantSection;
    }
    try {
      if (localStorage.getItem(LAYOUT_KEY) === "list") this.layout = "list";
    } catch {
      /* storage blocked */
    }
    this.syncMode();
    // ?store=purchases|marketplace deep-links a tab (?view= belongs to the router).
    const wantStore = params.get("store") ?? params.get("view");
    if (wantStore === "purchases" || /(?:^#|&)kv=/.test(window.location.hash)) this.pk.tab = "purchases";
    else if (wantStore === "marketplace") this.pk.setTab("marketplace");
    void this.refresh().then(() => {
      if (this.selectedId) void this.loadDetail();
      this.pk.connected();
      this.consumeInstallLink();
      void this.pu.load().then(() => this.pu.consumeReturnFragment());
    });
    // Drop a plugin package (.zip) anywhere on the page to import it.
    this.addEventListener("dragenter", this.pk.onDragEnter);
    this.addEventListener("dragover", this.pk.onDragOver);
    this.addEventListener("dragleave", this.pk.onDragLeave);
    this.addEventListener("drop", this.pk.onDrop);
    this.pollTimer = setInterval(() => void this.refresh(), 30000);
    // Page chrome + inline per-plugin appearance follow the global theme.
    this.themeObserver = new MutationObserver(() => {
      this.syncMode();
      this.requestUpdate();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("infinibot:plugins-open", this.onOpenRequest);
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener(PLAN_CHANNELS_EVENT, this.onPlanChannels);
    if (isCloudBuild()) {
      void this.loadPricing();
      // Back from the purchase tab: re-check what the member owns.
      window.addEventListener("focus", this.onWindowFocus);
    }
  }

  private pricingLoading = false;
  private pricingAt = 0;

  private async loadPricing(): Promise<void> {
    if (this.pricingLoading) return;
    this.pricingLoading = true;
    try {
      const next = await loadCloudPricing({ fetch: (...a) => fetch(...a), token: () => getClerkToken(), apiBase: marketplaceApiBase() });
      // A failed reload keeps what we knew.
      if (next) {
        this.pricing = next;
        // Install entitlements from the per-plugin access check also serve the Marketplace tab.
        for (const [id, tok] of next.tokens) this.pk.tokens.set(id, tok);
      }
      this.pricingAt = Date.now();
    } finally {
      this.pricingLoading = false;
    }
  }

  private onWindowFocus = () => {
    const gated = this.pricing && this.plugins.some((p) => paidGate(p, this.pricing));
    if (gated && Date.now() - this.pricingAt > 5000) void this.loadPricing();
  };

  private gateOf(p: PluginSummary): PaidGate | null {
    if (this.pending.has(p.id) || cloudBlock(p)) return null;
    // Entitled here (KinglyVault plan / purchase / owner grant): never Buy.
    if (p.access?.requires.purchase && p.access.loadable) return null;
    return paidGate(p, this.pricing);
  }

  /** Our marketplace page (cloud checkout) for first-party, the seller's page for external. */
  private buy(gate: PaidGate): void {
    if (gate.url) window.open(gate.url, "_blank", "noopener,noreferrer");
  }

  /** KinglyVault CEO plan page (new tab): the plan that includes every paid first-party plugin. */
  private renderVaultUnlock(p: Pick<PluginSummary, "id" | "name">, cls = "") {
    return html`<a
      class="pm-action primary pm-vault-unlock ${cls}"
      data-vault-unlock=${p.id}
      href=${kinglyVaultUrls().ceoUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label=${`${VAULT_UNLOCK_ACTION} — ${p.name} is ${VAULT_INCLUDED_LABEL.toLowerCase()}`}
      @click=${(e: Event) => e.stopPropagation()}
    >${VAULT_UNLOCK_ACTION}</a>`;
  }

  private renderVaultDownloads() {
    return html`<a class="pm-link pm-vault-dl" data-vault-downloads href=${kinglyVaultUrls().downloadsUrl} target="_blank" rel="noopener noreferrer"
      @click=${(e: Event) => e.stopPropagation()}>${VAULT_DOWNLOADS_ACTION}</a>`;
  }

  /** "Included in CEO plan" chip for a paid first-party plugin (cloud only). */
  private renderVaultBadge(p: PluginSummary) {
    const v = vaultForPlugin(p.id, this.pricing);
    return v ? html`<span class="pm-vault-badge" data-vault-badge>${v.badge}</span>` : nothing;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubGuided?.();
    this.pk.disconnected();
    this.removeEventListener("dragenter", this.pk.onDragEnter);
    this.removeEventListener("dragover", this.pk.onDragOver);
    this.removeEventListener("dragleave", this.pk.onDragLeave);
    this.removeEventListener("drop", this.pk.onDrop);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.themeObserver?.disconnect();
    this.sectionObserver?.();
    this.mountedPanel?.cleanup?.();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("infinibot:plugins-open", this.onOpenRequest);
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("focus", this.onWindowFocus);
    window.removeEventListener(PLAN_CHANNELS_EVENT, this.onPlanChannels);
  }

  /** The plan's excluded channels changed (loaded at boot, or an upgrade): re-apply the locks. */
  private onPlanChannels = () => {
    this.plugins = applyPlanChannelLocks(this.rawPlugins, channelsExcluded());
  };

  /**
   * Agent navigation (ui_control → guide plan) and deep links while this page
   * is already mounted: `infinibot:plugins-open { plugin, section }` or a
   * history change to /plugins?plugin=<id>&ptab=<section>.
   */
  private onOpenRequest = (ev: Event) => {
    const d = (ev as CustomEvent<{ plugin?: string; section?: string }>).detail ?? {};
    this.openFromRequest(d.plugin ?? null, d.section ?? null);
  };

  /**
   * "Install in InfiniBot" from the marketplace site (`?install=<id>`): show the
   * Marketplace tab on that plugin and open the install review. The parameter
   * is dropped from the URL so a reload does not start it again.
   */
  private consumeInstallLink(): boolean {
    const link = parseInstallLink(window.location.search);
    if (!link) return false;
    const url = new URL(window.location.href);
    url.searchParams.delete("install");
    url.searchParams.delete("source");
    url.searchParams.delete("entitlement");
    url.searchParams.delete("plugin");
    url.searchParams.delete("ptab");
    window.history.replaceState(window.history.state, "", url.toString());
    if (link.token && this.pricing?.ownership.has(link.id)) {
      const ownership = new Map(this.pricing.ownership).set(link.id, "owned");
      this.pricing = { ...this.pricing, ownership };
    }
    const open = () => void this.pk.openInstallLink(link);
    if (this.selectedId) void this.select(null).then(open);
    else open();
    return true;
  }

  private onPopState = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "plugins" && !window.location.pathname.endsWith("/plugins")) return;
    if (this.consumeInstallLink()) return;
    this.openFromRequest(params.get("plugin"), params.get("ptab"));
  };

  private openFromRequest(plugin: string | null, section: string | null): void {
    const wantSection = isDetailSection(section) ? section : undefined;
    if (!plugin) {
      if (this.selectedId) void this.select(null);
      return;
    }
    if (plugin === this.selectedId) {
      if (wantSection && wantSection !== this.section) {
        if (this.detail) requestAnimationFrame(() => this.goToSection(wantSection));
        else this.pendingScroll = wantSection;
      }
      return;
    }
    void this.select(plugin, wantSection);
  }

  /**
   * Sticky bars stick to the scroll container's content edge, so its top
   * padding would let scrolled cards peek above them. Offset by that padding.
   */
  /** Nearest ancestor (across shadow roots) that scrolls the page content. */
  private scroller(): HTMLElement | null {
    let el: Element | null = this.parentElement ?? ((this.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
    while (el && el !== document.documentElement && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el as HTMLElement;
      el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
    }
    return null;
  }

  private measureStickyTop(): void {
    const sc = this.scroller();
    if (sc) this.style.setProperty("--pm-stick-top", `${-(parseFloat(getComputedStyle(sc).paddingTop) || 0)}px`);
  }

  /**
   * Scroll only the content scroller (never scrollIntoView: it also scrolls
   * the app shell, which shifts the whole chrome). The rect → CSS-px ratio
   * absorbs the laptop-scale body zoom.
   */
  private scrollToElement(el: HTMLElement, offset = 0): void {
    const sc = this.scroller();
    if (!sc) return;
    const scRect = sc.getBoundingClientRect();
    const ratio = scRect.height ? sc.clientHeight / scRect.height : 1;
    const delta = (el.getBoundingClientRect().top - scRect.top) * ratio - offset;
    sc.scrollBy({ top: delta, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  /** The host carries data-mode so the page never trusts palette-written --text/--bg. */
  private syncMode(): void {
    this.dataset.mode = currentThemeName();
  }

  // ── data ────────────────────────────────────────────────────────────

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.gwClient();
    if (!client) throw new Error("not connected to the gateway");
    return client.request<T>(method, params);
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.rpc<{
        plugins?: PluginSummary[];
        landingPluginId?: string | null;
        updates?: { checkedAt: string | null; registryUrl: string | null; error: string | null; available: number };
      }>("plugins.list");
      this.rawPlugins = res?.plugins ?? [];
      this.plugins = applyPlanChannelLocks(this.rawPlugins, channelsExcluded());
      this.pk.setUpdatesSummary(res?.updates);
      this.landingPluginId = res?.landingPluginId ?? null;
      this.loaded = true;
      this.resolvePending();
    } catch {
      /* keep last-known list through a reconnect */
    }
  }

  private selected(): PluginSummary | undefined {
    return this.plugins.find((p) => p.id === this.selectedId);
  }

  private syncUrl(): void {
    const url = new URL(window.location.href);
    if (this.selectedId) url.searchParams.set("plugin", this.selectedId);
    else url.searchParams.delete("plugin");
    if (this.selectedId && this.section !== "overview") url.searchParams.set("ptab", this.section);
    else url.searchParams.delete("ptab");
    window.history.replaceState(window.history.state, "", url.toString());
  }

  private async select(id: string | null, section?: DetailSectionId): Promise<void> {
    this.mountedPanel?.cleanup?.();
    this.mountedPanel = null;
    this.sectionObserver?.();
    this.sectionObserver = null;
    this.selectedId = id;
    this.detail = null;
    this.health = null;
    this.logs = [];
    this.config = null;
    this.configDraft = {};
    this.appearancePreview = null;
    this.appearanceDirty = false;
    this.detailError = null;
    this.section = section ?? "overview";
    this.pendingScroll = section ?? null;
    this.syncUrl();
    this.scrollPageTop();
    if (id) await this.loadDetail();
  }

  private scrollPageTop(): void {
    // The view scrolls inside the app's content column; bring its top back.
    requestAnimationFrame(() => {
      const sc = this.scroller();
      if (sc) sc.scrollTop = 0;
    });
  }

  private goToSection(id: DetailSectionId): void {
    this.section = id;
    // Keep the clicked section highlighted until the user scrolls themselves
    // (the programmatic smooth scroll, or hitting the page bottom, mustn't flip it).
    this.spyLocked = true;
    this.syncUrl();
    const el = this.renderRoot.querySelector<HTMLElement>(`#sec-${id}`);
    if (!el) return;
    const nav = this.renderRoot.querySelector<HTMLElement>(".pm-dnav");
    this.scrollToElement(el, (nav?.offsetHeight ?? 0) + 8);
    el.focus({ preventScroll: true });
  }

  private async loadDetail(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    try {
      const detail = await this.rpc<PluginDetail>("plugins.get", { id });
      if (this.selectedId !== id) return;
      this.detail = detail;
      this.detailError = null;
      if (!this.appearanceDirty) {
        this.appearanceDraft = {};
        this.appearancePreview = detail.appearance ?? null;
      }
      await this.loadSections();
    } catch (err) {
      this.detailError = errorMessage(err);
    }
  }

  /** Settings, health and logs load together — the listing is one page. */
  private async loadSections(opts: { keepDraft?: boolean } = { keepDraft: true }): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    const [cfg, health, logs] = await Promise.allSettled([
      this.rpc<ConfigPayload>("plugins.config.get", { id }),
      this.rpc<PluginHealth>("plugins.health", { id }),
      this.rpc<{ lines: PluginLogLine[] }>("plugins.logs", { id, limit: 150 }),
    ]);
    if (this.selectedId !== id) return;
    if (cfg.status === "fulfilled") {
      const dirty = this.config ? configChanges(this.config.values, this.configDraft, this.config.secretKeys).length > 0 : false;
      this.config = cfg.value;
      if (!(opts.keepDraft && dirty)) this.configDraft = { ...cfg.value.values };
    } else this.note(id, errorMessage(cfg.reason), "err");
    if (health.status === "fulfilled") this.health = health.value;
    if (logs.status === "fulfilled") this.logs = logs.value.lines;
    await this.updateComplete;
    void this.mountV1Panel();
    this.observeSections();
    if (this.pendingScroll) {
      const target = this.pendingScroll;
      this.pendingScroll = null;
      requestAnimationFrame(() => this.goToSection(target));
    }
  }

  private async reloadLogs(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    try {
      const [health, logs] = await Promise.all([
        this.rpc<PluginHealth>("plugins.health", { id }),
        this.rpc<{ lines: PluginLogLine[] }>("plugins.logs", { id, limit: 150 }),
      ]);
      this.health = health;
      this.logs = logs.lines;
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    }
  }

  /** Scroll-spy: the active section is the last one whose top has passed the sticky nav. */
  private observeSections(): void {
    this.sectionObserver?.();
    const sc = this.scroller();
    if (!sc) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const sections = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-section]")];
      if (!sections.length) return;
      const scRect = sc.getBoundingClientRect();
      const nav = this.renderRoot.querySelector<HTMLElement>(".pm-dnav");
      if (this.spyLocked) return;
      const line = (nav?.getBoundingClientRect().bottom ?? scRect.top) + 64;
      let active = sections[0]!.dataset.section;
      for (const sec of sections) if (sec.getBoundingClientRect().top <= line) active = sec.dataset.section;
      // At the very bottom the last short sections can never reach the line.
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) active = sections[sections.length - 1]!.dataset.section;
      if (active && isDetailSection(active) && active !== this.section) this.section = active;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const unlock = () => {
      this.spyLocked = false;
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) sc.addEventListener(ev, unlock, { passive: true });
    this.sectionObserver = () => {
      sc.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) sc.removeEventListener(ev, unlock);
      if (raf) cancelAnimationFrame(raf);
    };
  }


  private note(id: string, text: string, kind: Note["kind"] = "ok"): void {
    this.notes = new Map(this.notes).set(id, { text, kind });
  }

  private setBusy(key: string, on: boolean): void {
    const next = new Set(this.busy);
    if (on) next.add(key);
    else next.delete(key);
    this.busy = next;
  }

  private async afterLiveChange(): Promise<void> {
    await Promise.all([this.refresh(), this.loadDetail()]);
    // Contributed nav/pages + scoped appearance follow immediately.
    await syncPluginHost(this.gwClient());
    this.state?.requestUpdate?.();
  }

  /** Make (or stop making) a plugin's declared landing page the start page. No restart. */
  private async setLanding(p: PluginSummary, on: boolean): Promise<void> {
    this.setBusy("landing", true);
    try {
      await this.rpc("plugins.setLanding", { id: on ? p.id : null });
      this.landingPluginId = on ? p.id : null;
      this.note(p.id, on ? "Opens first when InfiniBot starts." : "The dashboard opens first again.");
      await syncPluginHost(this.gwClient());
      this.state?.requestUpdate?.();
    } catch (err) {
      this.note(p.id, `Couldn't change the start page: ${errorMessage(err)}`, "err");
    } finally {
      this.setBusy("landing", false);
    }
  }

  private async countRunningSubagents(): Promise<void> {
    this.runningSubagents = null;
    try {
      const res = await this.rpc<{ subagents?: { status?: string }[] }>("subagents.list", { compact: true, limit: 100 });
      this.runningSubagents = (res.subagents ?? []).filter((s) => !DONE_STATES.has(String(s.status ?? "").toLowerCase())).length;
    } catch {
      this.runningSubagents = null;
    }
  }

  private openModal(modal: Modal): void {
    // A paid plugin this member hasn't bought opens its purchase page, never Enable.
    const gate = modal.kind === "enable" && modal.enabled ? this.gateOf(modal.plugin) : null;
    if (gate) return this.buy(gate);
    this.modal = modal;
    if (modal.kind === "enable" || modal.kind === "config" || modal.kind === "reload" || modal.kind === "uninstall") {
      void this.countRunningSubagents();
    }
  }

  // ── enable / disable (restart) ──────────────────────────────────────

  private resolvePending(): void {
    if (this.pending.size === 0) return;
    const next = new Map(this.pending);
    for (const [id, want] of this.pending) {
      const p = this.plugins.find((x) => x.id === id);
      if (!p || p.enabled !== want) continue;
      next.delete(id);
      this.note(id, p.status === "error" ? (p.error ?? "plugin failed to load") : want ? "Turned on." : "Turned off.", p.status === "error" ? "err" : "ok");
    }
    if (next.size !== this.pending.size) {
      this.pending = next;
      void syncPluginHost(this.gwClient()).then(() => this.state?.requestUpdate?.());
      if (this.selectedId) void this.loadDetail();
    }
    if (this.pending.size === 0 && this.pendingTimer) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async setEnabled(p: PluginSummary, enabled: boolean): Promise<void> {
    if (this.pending.has(p.id)) return;
    this.pending = new Map(this.pending).set(p.id, enabled);
    this.note(p.id, "Applying — the gateway is restarting to load plugins…", "warn");
    try {
      await this.rpc("plugins.setEnabled", { id: p.id, enabled });
    } catch (err) {
      const pending = new Map(this.pending);
      pending.delete(p.id);
      this.pending = pending;
      this.note(p.id, `Couldn't change it: ${errorMessage(err)}`, "err");
      return;
    }
    if (!this.pendingTimer) this.pendingTimer = setInterval(() => void this.refresh(), 1500);
  }

  // ── live actions ────────────────────────────────────────────────────

  private async toggleContribution(c: ContributionState, enabled: boolean): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy(c.key, true);
    try {
      await this.rpc("plugins.contributions.set", { id, key: c.key, enabled });
      this.note(id, `${c.kindLabel} “${c.label}” turned ${enabled ? "on" : "off"}${c.live ? " — applied now, no restart." : " — saved."}`);
      await this.afterLiveChange();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy(c.key, false);
    }
  }

  private async setPermission(perm: PermissionState, granted: boolean): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy(perm.key, true);
    try {
      const res = await this.rpc<{ disabledNow: string[]; enabledNow: string[] }>("plugins.permissions.set", { id, key: perm.key, granted });
      const changed = granted ? res.enabledNow : res.disabledNow;
      this.note(
        id,
        `${granted ? "Granted" : isDefaultOffPermission(perm) ? "Turned off" : "Revoked"} ${perm.key}.${changed.length ? ` ${granted ? "Turned back on" : "Turned off"}: ${changed.join(", ")}.` : ""} Applied now, no restart.`,
        granted ? "ok" : "warn",
      );
      await this.afterLiveChange();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy(perm.key, false);
    }
  }

  private async saveConfig(values: Record<string, unknown>): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy("config", true);
    try {
      const res = await this.rpc<{ restartRequired: boolean }>("plugins.config.set", { id, values });
      this.note(id, res.restartRequired ? "Settings saved — the gateway is reloading the plugin." : "Settings saved.", res.restartRequired ? "warn" : "ok");
      if (res.restartRequired) {
        // Treat what was sent as saved (secrets back to masks) until the reload lands.
        const cfg = this.config;
        if (cfg) {
          const saved: Record<string, unknown> = { ...values };
          for (const k of cfg.secretKeys) {
            const was = (cfg.values[k] as { set?: boolean } | undefined)?.set === true;
            saved[k] = { __secret: true, set: was || (typeof values[k] === "string" && values[k] !== "") };
          }
          this.config = { ...cfg, values: saved };
          this.configDraft = { ...saved };
        }
        setTimeout(() => void this.loadDetail(), 4000);
      } else await this.loadSections({ keepDraft: false });
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("config", false);
    }
  }

  private updateAppearance(key: string, value: unknown): void {
    const next = { ...this.appearanceDraft };
    if (value === undefined) delete next[key];
    else next[key] = value;
    this.appearanceDraft = next;
    this.appearanceDirty = true;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.previewAppearance(), 120);
  }

  private mergedAppearanceDraft(): Record<string, unknown> {
    const cur = this.detail?.appearance;
    const base: Record<string, unknown> = {};
    if (cur?.customized) {
      const v = cur.values;
      const d = cur.defaults;
      for (const k of ["accent", "tint", "tintStrength", "density", "fontScale", "icon", "monogram"] as const) {
        if (v[k] !== undefined && v[k] !== d[k]) base[k] = v[k];
      }
      const layout = Object.fromEntries(Object.entries(v.layout).filter(([k, val]) => d.layout.find((l) => l.id === k)?.default !== val));
      if (Object.keys(layout).length) base.layout = layout;
      const vars = Object.fromEntries(Object.entries(v.variables).filter(([k, val]) => d.variables.find((x) => x.name === k)?.default !== val));
      if (Object.keys(vars).length) base.variables = vars;
    }
    const merged = { ...base, ...this.appearanceDraft };
    for (const [k, v] of Object.entries(merged)) if (v === "__default__") delete merged[k];
    return merged;
  }

  private async previewAppearance(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    try {
      this.appearancePreview = await this.rpc<ResolvedAppearance>("plugins.appearance.preview", { id, appearance: this.mergedAppearanceDraft() });
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    }
  }

  private async saveAppearance(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy("appearance", true);
    try {
      const res = await this.rpc<ResolvedAppearance>("plugins.appearance.set", { id, appearance: this.mergedAppearanceDraft() });
      this.appearanceDirty = false;
      this.appearanceDraft = {};
      this.note(
        id,
        `Appearance saved — applied to ${this.detail?.plugin.name ?? id} now, no restart.${res.adjustments.length ? ` ${res.adjustments.length} colour(s) adjusted for WCAG AA contrast.` : ""}`,
      );
      await this.afterLiveChange();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("appearance", false);
    }
  }

  private async resetAppearance(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy("appearance", true);
    try {
      await this.rpc("plugins.appearance.reset", { id });
      this.appearanceDirty = false;
      this.appearanceDraft = {};
      this.note(id, "Appearance reset to the plugin's defaults.");
      await this.afterLiveChange();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("appearance", false);
    }
  }

  private async restartServices(full: boolean): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy("restart", true);
    try {
      const res = await this.rpc<{ mode: string; services?: { id: string; running: boolean }[] }>("plugins.restart", { id, full });
      this.note(
        id,
        res.mode === "gateway"
          ? "Reloading — the gateway is restarting."
          : `Restarted ${res.services?.length ?? 0} service(s) in place — no gateway restart.`,
        res.mode === "gateway" ? "warn" : "ok",
      );
      if (res.mode === "gateway") setTimeout(() => void this.loadDetail(), 4000);
      else await this.reloadLogs();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("restart", false);
    }
  }

  private download(name: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private async exportData(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy("data", true);
    try {
      const bundle = await this.rpc<{ files: unknown[] }>("plugins.data.export", { id });
      this.download(`${id}-data-${new Date().toISOString().slice(0, 10)}.json`, bundle);
      this.note(id, `Exported ${bundle.files.length} file(s).`);
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("data", false);
    }
  }

  private async importFile(e: Event, importer?: string): Promise<void> {
    const id = this.selectedId;
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!id || !file) return;
    this.setBusy("data", true);
    try {
      const text = await file.text();
      if (importer) {
        await this.rpc("plugins.data.import", { id, importer, payload: { filename: file.name, content: text } });
        this.note(id, `Imported ${file.name} via ${importer}.`);
      } else {
        const res = await this.rpc<{ written: number }>("plugins.data.import", { id, bundle: JSON.parse(text), mode: this.dataImportMode });
        this.note(id, `Restored ${res.written} file(s) (${this.dataImportMode}).`);
      }
      await this.loadDetail();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("data", false);
    }
  }

  private async runImporter(importer: string, label: string): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.setBusy("data", true);
    try {
      await this.rpc("plugins.data.import", { id, importer, payload: {} });
      this.note(id, `${label}: done.`);
      await this.loadDetail();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    } finally {
      this.setBusy("data", false);
    }
  }

  private async clearData(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    try {
      const res = await this.rpc<{ bytes: number }>("plugins.data.clear", { id, confirm: id });
      this.note(id, `Cleared ${formatBytes(res.bytes)} of plugin data.`, "warn");
      await this.loadDetail();
    } catch (err) {
      this.note(id, errorMessage(err), "err");
    }
  }

  private async uninstall(keepData: boolean): Promise<void> {
    const p = this.selected();
    if (!p) return;
    try {
      const res = await this.rpc<{ restartRequired: boolean; bundled: boolean; removedPackage: boolean }>("plugins.uninstall", { id: p.id, keepData });
      this.note(
        p.id,
        `Uninstalled ${p.name} — ${keepData ? "its data was kept" : "its data was removed"}.${res.bundled ? " It ships with InfiniBot, so it stays listed (off) and can be turned back on." : ""}${res.restartRequired ? " The gateway is reloading." : ""}`,
        "warn",
      );
      if (res.restartRequired) setTimeout(() => void this.refresh().then(() => this.loadDetail()), 4000);
      else await this.afterLiveChange();
    } catch (err) {
      this.note(p.id, errorMessage(err), "err");
    }
  }

  private async mountV1Panel(): Promise<void> {
    const p = this.selected();
    if (!p?.ui || p.status !== "loaded" || this.mountedPanel) return;
    const client = this.gwClient();
    const container = this.renderRoot.querySelector<HTMLElement>(`[data-panel="${p.id}"]`);
    if (!client || !container) return;
    const base = httpBaseFromWsUrl(client.url);
    try {
      const mod = await import(/* @vite-ignore */ base ? `${base}${p.ui.entry}` : p.ui.entry);
      if (typeof mod?.default !== "function") {
        container.textContent = "plugin UI module has no default export";
        return;
      }
      const cleanup = mod.default(container, { client, pluginId: p.id });
      this.mountedPanel = { cleanup: typeof cleanup === "function" ? cleanup : undefined };
    } catch (err) {
      container.textContent = `failed to load plugin UI: ${errorMessage(err)}`;
    }
  }

  // ── keyboard ────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): void {
    if (this.lightbox) {
      if (e.key === "Escape") this.closeLightbox();
      else if (e.key === "ArrowRight") this.stepLightbox(1);
      else if (e.key === "ArrowLeft") this.stepLightbox(-1);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && this.pk.handleEscape()) {
      e.preventDefault();
      return;
    }
    if (this.modal && e.key === "Escape") {
      this.modal = null;
      e.preventDefault();
    }
  }

  private openLightbox(plugin: string, images: Lightbox["images"], index: number, from: HTMLElement): void {
    this.returnFocus = from;
    this.lightbox = { plugin, images, index };
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".pm-lb-close")?.focus());
  }

  private closeLightbox(): void {
    this.lightbox = null;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private stepLightbox(d: number): void {
    const lb = this.lightbox;
    if (!lb) return;
    this.lightbox = { ...lb, index: (lb.index + d + lb.images.length) % lb.images.length };
  }

  // ── browse actions ──────────────────────────────────────────────────

  private setQuery(patch: Partial<BrowseQuery>): void {
    this.query = { ...this.query, ...patch };
  }

  private setLayout(layout: "grid" | "list"): void {
    this.layout = layout;
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* storage blocked */
    }
  }

  private runPrimary(p: PluginSummary, a: PrimaryAction): void {
    switch (a.kind) {
      case "enable":
        this.openModal({ kind: "enable", plugin: p, enabled: true });
        return;
      case "open":
        this.state?.setTab(a.tab as Tab);
        return;
      case "channels":
        this.state?.setTab("channels" as Tab);
        return;
      case "upgrade":
        void openUpgrade("pro", { source: `plugins:${p.id}` });
      case "buy":
        if (p.access?.status === "expired") {
          // Reconnect: the detail page's call-out holds the Connect KinglyVault panel.
          if (this.pu.deviceFlow) void this.select(p.id);
          else void this.pu.connect(p.id);
        } else void this.pu.buy(p.id);
        return;
      default:
        void this.select(p.id, a.section as DetailSectionId | undefined);
    }
  }

  // ── render: shared bits ─────────────────────────────────────────────

  /** Listing image URL; on the hosted cloud, a Bearer-loaded blob: URL (undefined while loading). */
  private img(src: string | undefined): string | undefined {
    if (!src || this.brokenImages.has(src)) return undefined;
    return gatewayImageSrc(src, () => this.requestUpdate(), () => this.markBroken(src));
  }

  private coverSrc(p: PluginSummary): string {
    const own = p.listing?.cover;
    return this.img(own) ?? generatedCover(p.id, categoryOf(p), monogramOf(p));
  }

  private markBroken(src: string | undefined): void {
    if (!src || this.brokenImages.has(src)) return;
    this.brokenImages = new Set(this.brokenImages).add(src);
  }

  private iconOf(p: PluginSummary): CardIcon {
    const icon = p.listing?.icon;
    const src = icon ? this.img(icon) : undefined;
    return src
      ? { src, monogram: monogramOf(p), onError: () => this.markBroken(icon) }
      : { monogram: monogramOf(p), scopeId: p.id, scopeStyle: pluginScopeInlineStyle(p.id) };
  }

  private renderIcon(p: PluginSummary, size: "sm" | "md" | "lg" | "xl" = "md") {
    return renderCardIcon(this.iconOf(p), size);
  }

  private renderStatus(p: PluginSummary) {
    const st = cardStatus(p, this.pending.has(p.id));
    return html`<span class="pm-status s-${st.kind}" title=${st.detail ?? st.label} data-status=${st.kind}><span class="pm-dot"></span>${st.label}</span>`;
  }

  private renderTier(p: PluginSummary) {
    const t = tierOf(p);
    return html`<span class="pm-tier t-${t}" title=${t === "first-party" ? "Made by InfiniBot and shipped with it" : t === "verified" ? "Published by InfiniBot" : "Third-party publisher"}>${t === "first-party" ? html`<span class="pm-tier-glyph">${ICONS.shield}</span>` : nothing}${TIER_LABELS[t]}</span>`;
  }

  private publisherOf(p: PluginSummary): string {
    return p.listing?.publisher?.name ?? (p.publisher === "infinibot" ? "InfiniBot" : p.publisher) ?? (p.origin === "bundled" ? "InfiniBot" : p.origin);
  }

  private taglineOf(p: PluginSummary): string {
    return p.listing?.tagline ?? p.description ?? "";
  }

  private renderSwitch(p: PluginSummary, labelled = false) {
    // A channel the plan leaves out (Free: Telegram, Slack): the upgrade, not a toggle.
    const lockedChannel = p.cloud?.lockedChannel;
    if (lockedChannel && !p.enabled && !this.pending.has(p.id)) {
      return html`<button
        class="pm-plan-lock"
        data-plugin-plan-lock=${p.id}
        data-testid="plugin-plan-lock"
        title=${p.cloud?.reason ?? ""}
        aria-label=${`${p.name}: ${channelUpgradeCta(lockedChannel)}`}
        @click=${(e: Event) => {
          e.stopPropagation();
          void openUpgrade("pro", { source: `plugins:${p.id}` });
        }}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="16" height="10" x="4" y="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>${labelled ? channelUpgradeCta(lockedChannel) : "Upgrade"}</button>`;
    }
    const on = this.pending.get(p.id) ?? p.enabled;
    return html`<button
      class="pp-switch"
      role="switch"
      aria-checked=${String(on)}
      aria-label=${`${p.name}: ${on ? "on" : "off"} (restarts the gateway)`}
      data-plugin-toggle=${p.id}
      title=${(cloudBlock(p) ?? accessBlock(p))?.detail ?? (this.gateOf(p) ? `Paid plugin (${this.gateOf(p)!.entry.priceLabel}): buy it to turn it on` : "")}
      ?disabled=${this.pending.has(p.id) || (Boolean(cloudBlock(p) ?? accessBlock(p)) && !p.enabled) || Boolean(this.gateOf(p))}
      @click=${(e: Event) => {
        e.stopPropagation();
        this.openModal({ kind: "enable", plugin: p, enabled: !p.enabled });
      }}
    ></button>${labelled ? html`<span class="pm-switch-label">${this.pending.has(p.id) ? "Applying…" : on ? "On" : "Off"}</span>` : nothing}`;
  }

  private renderPrimaryButton(p: PluginSummary, cls = "") {
    const gate = this.gateOf(p);
    if (gate?.vault) {
      return html`${this.renderVaultUnlock(p, cls)}<button
        class="pm-action pm-buy-secondary ${cls}"
        data-primary="buy"
        data-market-buy=${p.id}
        aria-label=${`${gate.label} — ${p.name} only`}
        ?disabled=${!gate.url}
        @click=${(e: Event) => {
          e.stopPropagation();
          this.buy(gate);
        }}
      >${gate.label}</button>`;
    }
    if (gate) {
      return html`<button
        class="pm-action primary ${cls}"
        data-primary=${gate.kind === "external" ? "external" : "buy"}
        data-market-buy=${p.id}
        aria-label=${`${gate.label} — ${p.name}`}
        ?disabled=${!gate.url}
        @click=${(e: Event) => {
          e.stopPropagation();
          this.buy(gate);
        }}
      >${gate.label}</button>`;
    }
    const a = primaryAction(p, this.pending.has(p.id));
    return html`<button
      class="pm-action ${a.kind === "enable" || a.kind === "open" || a.kind === "upgrade" || a.kind === "buy" ? "primary" : ""} ${cls}"
      data-primary=${a.kind}
      data-testid=${a.kind === "upgrade" ? "plugin-plan-upgrade" : nothing}
      aria-label=${`${a.label} ${p.name}`}
      @click=${(e: Event) => {
        e.stopPropagation();
        this.runPrimary(p, a);
      }}
    >${a.label}</button>`;
  }

  // ── render: browse ──────────────────────────────────────────────────

  private renderCard(p: PluginSummary) {
    const tags = p.listing?.tags ?? [];
    return renderPluginCard({
      id: p.id,
      kind: "plugin",
      className: p.enabled ? "is-on" : "",
      name: p.name,
      cover: this.coverSrc(p),
      onCoverError: () => this.markBroken(p.listing?.cover),
      icon: this.iconOf(p),
      onOpen: () => void this.select(p.id),
      publisher: this.publisherOf(p),
      verified: tierOf(p) !== "community",
      version: p.version,
      tagline: this.taglineOf(p),
      coverBadges: html`${this.renderTier(p)}${this.pu.renderBadges(p)}${this.pk.renderUpdateBadge(p)}`,
      tags: html`${this.renderVaultBadge(p)}<span class="pm-chip cat">${categoryLabel(categoryOf(p))}</span>${tags.slice(0, 2).map((t) => html`<span class="pm-chip">${t}</span>`)}`,
      footStart: this.renderStatus(p),
      footActions: html`${this.renderTourButton(p)}${this.renderPrimaryButton(p)}`,
    });
  }

  private renderRow(p: PluginSummary) {
    return html`<div class="pm-row" role="listitem" data-plugin-row=${p.id}>
      ${this.renderIcon(p, "sm")}
      <div class="pm-row-main">
        <button class="pm-row-name" @click=${() => this.select(p.id)} data-open-detail=${p.id}>${p.name}</button>
        <div class="pm-row-sub">${this.pk.renderUpdateBadge(p)} ${this.taglineOf(p)}</div>
      </div>
      <span class="pm-chip cat pm-hide-sm">${categoryLabel(categoryOf(p))}</span>
      <span class="pm-row-ver pm-hide-sm">${p.version ? `v${p.version}` : "—"}</span>
      ${this.renderStatus(p)}
      ${this.renderSwitch(p)}
    </div>`;
  }

  private renderSkeletons() {
    return renderCardSkeletons(6, "Loading plugins");
  }

  private renderEmpty(counts: ReturnType<typeof filterCounts>) {
    const q = this.query;
    if (q.filter === "available" && counts.available === 0 && !q.q && !q.category && !q.tiers.length) {
      return html`<div class="pm-empty" data-empty="available">
        <span class="pm-empty-art">${ICONS.puzzle}</span>
        <h3>Everything that ships with InfiniBot is already on</h3>
        <p>The plugin registry isn't live yet. When it is, community and marketplace plugins will show up here to install.</p>
        <button class="pm-action" @click=${() => this.setQuery({ filter: "all" })}>Show all plugins</button>
      </div>`;
    }
    return html`<div class="pm-empty" data-empty="filtered">
      <span class="pm-empty-art">${ICONS.search}</span>
      <h3>No plugins match${q.q.trim() ? html` “${q.q.trim()}”` : nothing}</h3>
      <p>Try a different search, or clear the filters to see all ${counts.all} plugins.</p>
      <button class="pm-action primary" data-clear-filters @click=${() => (this.query = { ...DEFAULT_QUERY, sort: this.query.sort })}>Clear filters</button>
    </div>`;
  }

  private renderShelf() {
    const installed = this.plugins.filter(isInstalled).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    if (!installed.length) return nothing;
    return html`<section class="pm-section pm-shelf-wrap" aria-labelledby="shelf-h" data-learn-id="plugins-installed">
      <div class="pm-section-head">
        <h2 id="shelf-h" class="pm-section-title">Installed <span class="pm-count">${installed.length}</span></h2>
        <button class="pm-link" @click=${() => this.setQuery({ filter: "installed" })}>See all</button>
      </div>
      <div class="pm-shelf" role="list" data-shelf>
        ${installed.map(
          (p) => html`<div class="pm-tile" role="listitem" data-plugin-tile=${p.id}>
            ${this.renderIcon(p, "sm")}
            <div class="pm-tile-main">
              <button class="pm-tile-name" @click=${() => this.select(p.id)}>${p.name}</button>
              ${this.renderStatus(p)}
            </div>
          </div>`,
        )}
      </div>
    </section>`;
  }

  private renderToolbar(counts: ReturnType<typeof filterCounts>) {
    const q = this.query;
    const cats = presentCategories(this.plugins);
    return html`<div class="pm-toolbar" role="search" data-learn-id="plugins-toolbar">
      <div class="pm-toolbar-row">
        <label class="pm-search" data-learn-id="plugins-search">
          <span class="pm-search-ic">${ICONS.search}</span>
          <input type="search" placeholder="Search plugins, channels, tags…" aria-label="Search plugins" .value=${q.q} @input=${(e: Event) => this.setQuery({ q: (e.target as HTMLInputElement).value })} />
        </label>
        <div class="pm-seg" role="radiogroup" aria-label="Show" data-learn-id="plugins-filters">
          ${FILTERS.map(
            (f) => html`<button role="radio" aria-checked=${String(q.filter === f.id)} data-filter=${f.id} @click=${() => this.setQuery({ filter: f.id })}>${f.label}<span class="pm-seg-n">${counts[f.id]}</span></button>`,
          )}
        </div>
        <div class="pm-toolbar-end">
          <label class="pm-sort"><span class="pp-sr">Sort by</span>
            <select aria-label="Sort by" @change=${(e: Event) => this.setQuery({ sort: (e.target as HTMLSelectElement).value as BrowseQuery["sort"] })}>
              ${SORTS.map((s) => html`<option value=${s.id} ?selected=${q.sort === s.id}>${s.label}</option>`)}
            </select>
          </label>
          <div class="pm-layout" role="group" aria-label="Layout" data-learn-id="plugins-layout">
            <button aria-pressed=${String(this.layout === "grid")} aria-label="Grid view" title="Grid view" data-layout="grid" @click=${() => this.setLayout("grid")}>${ICONS.grid}</button>
            <button aria-pressed=${String(this.layout === "list")} aria-label="Compact list" title="Compact list" data-layout="list" @click=${() => this.setLayout("list")}>${ICONS.list}</button>
          </div>
        </div>
      </div>
      <div class="pm-chips-row">
        <div class="pm-chipset" role="group" aria-label="Category" data-learn-id="plugins-categories">
          <button class="pm-fchip" aria-pressed=${String(!q.category)} @click=${() => this.setQuery({ category: null })}>All categories</button>
          ${cats.map(
            (c) => html`<button class="pm-fchip" aria-pressed=${String(q.category === c.id)} data-category=${c.id} @click=${() => this.setQuery({ category: q.category === c.id ? null : c.id })}>${c.id === "apps" ? "Apps" : c.label}<span class="pm-seg-n">${c.count}</span></button>`,
          )}
        </div>
        <div class="pm-chipset" role="group" aria-label="Trust tier" data-learn-id="plugins-tiers">
          ${TIERS.map((t) => {
            const on = q.tiers.includes(t);
            return html`<button class="pm-fchip tier t-${t}" aria-pressed=${String(on)} data-tier=${t} @click=${() => this.setQuery({ tiers: on ? q.tiers.filter((x) => x !== t) : [...q.tiers, t] })}>${TIER_LABELS[t]}</button>`;
          })}
        </div>
      </div>
    </div>`;
  }

  private renderBrowse() {
    const counts = filterCounts(this.plugins);
    const list = applyQuery(this.plugins, this.query);
    const grouped = isDefaultQuery(this.query) && this.query.sort === "recommended";
    const on = this.plugins.filter((p) => p.status === "loaded").length;
    const body = !this.loaded
      ? this.renderSkeletons()
      : !list.length
        ? this.renderEmpty(counts)
        : this.layout === "list"
          ? html`<div class="pm-list" role="list" aria-label="Plugins">${list.map((p) => this.renderRow(p))}</div>`
          : grouped
            ? groupSections(list).map(
                (s) => html`<section class="pm-section" aria-labelledby=${`sec-h-${s.id}`} data-browse-section=${s.id}>
                  <div class="pm-section-head">
                    <div>
                      <h2 id=${`sec-h-${s.id}`} class="pm-section-title">${s.title} <span class="pm-count">${s.plugins.length}</span></h2>
                      ${s.blurb ? html`<p class="pm-section-blurb">${s.blurb}</p>` : nothing}
                    </div>
                  </div>
                  <div class="pm-grid">${s.plugins.map((p) => this.renderCard(p))}</div>
                </section>`,
              )
            : html`<div class="pm-results-meta" aria-live="polite">${list.length} of ${counts.all} plugins</div><div class="pm-grid">${list.map((p) => this.renderCard(p))}</div>`;
    return html`
      <header class="pm-hero" data-learn-id="plugins-hero">
        <div class="pm-hero-glow" aria-hidden="true"></div>
        <div class="pm-hero-text">
          <p class="pm-eyebrow">InfiniBot · Plugins</p>
          <h1 class="pm-hero-title">Plugins</h1>
          <p class="pm-hero-sub">Add apps, channels and integrations to InfiniBot. Everything runs on your gateway — you choose what each plugin may do.</p>
        </div>
        <dl class="pm-hero-stats" aria-label="Summary">
          <div><dt>Installed</dt><dd>${this.loaded ? counts.installed : "—"}</dd></div>
          <div><dt>On</dt><dd>${this.loaded ? on : "—"}</dd></div>
          <div><dt>Available</dt><dd>${this.loaded ? counts.available : "—"}</dd></div>
        </dl>
      </header>
      ${this.pk.renderTabs()}
      ${this.pu.renderNote()}
      ${this.pk.tab === "marketplace"
        ? this.pk.renderMarketplace()
        : this.pk.tab === "purchases"
          ? this.pu.renderTab()
          : html`<div class="pm-kv-link" data-learn-id="plugins-kinglyvault"><kv-connect-card mode="card" .client=${this.gwClient()} @kv-changed=${() => void this.pu.afterKvChange()}></kv-connect-card></div>
            ${this.loaded ? this.pu.renderConnectStrip() : nothing}${this.renderToolbar(counts)}
            ${this.loaded && grouped && this.layout === "grid" ? html`${this.pu.renderRecommended((p) => this.renderCard(p))}${this.renderShelf()}` : nothing}
            <div class="pm-results" data-results data-learn-id="plugins-results">${body}</div>`}
    `;
  }

  // ── render: detail sections ─────────────────────────────────────────

  private renderGallery(p: PluginSummary) {
    const shots = (p.listing?.screenshots ?? []).filter((s) => !this.brokenImages.has(s.src));
    return renderGallery({
      name: p.name,
      shots,
      src: (s) => this.img(s.src),
      onError: (s) => this.markBroken(s.src),
      onOpen: (i, from) => this.openLightbox(p.id, shots, i, from),
    });
  }

  private renderOverview(d: PluginDetail) {
    const p = d.plugin;
    const md = p.listing?.description;
    const tags = p.listing?.tags ?? [];
    return html`
      ${accessBlock(p) && !p.enabled ? nothing : this.pu.renderAccessCallout(p)}
      ${this.renderGallery(p)}
      <div class="pm-overview">
        <div class="pm-prose" data-description>
          ${md ? unsafeHTML(toSanitizedMarkdownHtml(md)) : html`<p>${p.description ?? html`<span class="pp-muted">No description.</span>`}</p>`}
        </div>
        ${tags.length ? html`<div class="pm-tags lg">${tags.map((t) => html`<span class="pm-chip">${t}</span>`)}</div>` : nothing}
        ${(p.permissions as { phi?: boolean } | undefined)?.phi
          ? html`<div class="pp-note warn" data-phi><b>Patient data.</b> ${p.name} stores protected health information on this gateway. Keep backups encrypted and limit who can sign in.</div>`
          : nothing}
        ${p.contributes?.landing && p.status === "loaded"
          ? html`<div class="pm-inline-setting">
              <div><div class="pm-set-title">Open ${p.name} first</div><div class="pp-help">Make it the start page when InfiniBot opens. Applies now, no restart.</div></div>
              <button class="pp-switch" role="switch" data-landing=${p.id} aria-checked=${String(this.landingPluginId === p.id)} aria-label=${`Open ${p.name} first`} ?disabled=${this.busy.has("landing")} @click=${() => this.setLanding(p, this.landingPluginId !== p.id)}></button>
            </div>`
          : nothing}
        ${p.ui && p.status === "loaded"
          ? html`<div class="pm-sub">
              <h4 class="pp-h">${p.ui.navLabel}</h4>
              <div data-panel=${p.id} data-plugin-scope=${p.id} style="${pluginScopeInlineStyle(p.id)};min-height:40px;border:1px dashed var(--pp-line);border-radius:8px;padding:8px;height:auto;"></div>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderFacts(d: PluginDetail) {
    const p = d.plugin;
    const links = p.listing?.links ?? {};
    const home = d.homepage ?? p.listing?.publisher?.url;
    const compat = p.manifestVersion === 2 ? p.status !== "error" || !/plugin API/.test(p.error ?? "") : true;
    const updated = formatDate(d.updatedAt);
    const ext = (href: string, label: string) =>
      html`<a class="pm-ext" href=${href} target="_blank" rel="noopener noreferrer">${label}<span class="pm-ext-ic">${ICONS.ext}</span></a>`;
    return html`<dl class="pm-facts" data-facts>
      <div><dt>Version</dt><dd>${p.version ? `v${p.version}` : "—"}</dd></div>
      <div><dt>Publisher</dt><dd>${this.publisherOf(p)}</dd></div>
      <div><dt>Trust</dt><dd>${TIER_LABELS[tierOf(p)]} <span class="pp-muted">· ${p.origin}</span></dd></div>
      <div><dt>License</dt><dd>${p.license ?? "Not declared"}</dd></div>
      <div><dt>Compatibility</dt><dd>${p.manifestVersion === 2
        ? html`<span class=${compat ? "pm-ok" : "pm-bad"}>${compat ? ICONS.check : ICONS.warn}</span> Plugin API <span class="pp-code">${d.pluginApiRange ?? "?"}</span> <span class="pp-muted">(host ${d.pluginApiVersion})</span>`
        : html`Manifest v1 <span class="pp-muted">(implicit capabilities)</span>`}</dd></div>
      ${updated ? html`<div><dt>Updated</dt><dd>${updated}</dd></div>` : nothing}
      ${home || links.docs || links.support || links.source
        ? html`<div class="pm-facts-links"><dt>Links</dt><dd>
            ${home ? ext(home, "Homepage") : nothing}
            ${links.docs ? ext(links.docs, "Docs") : nothing}
            ${links.support ? ext(links.support, "Support") : nothing}
            ${links.source ? ext(links.source, "Source") : nothing}
          </dd></div>`
        : nothing}
    </dl>`;
  }

  private renderContributions(d: PluginDetail) {
    if (d.plugin.manifestVersion !== 2) {
      return html`<p class="pp-p pp-muted">This is a v1 plugin: it doesn't declare what it adds up front, so pieces can't be switched individually. Registered RPC methods: ${d.plugin.gatewayMethods?.length ?? 0}.</p>`;
    }
    if (!d.contributions.length) return html`<p class="pp-p pp-muted">This plugin declares no contributions.</p>`;
    const groups = new Map<string, ContributionState[]>();
    for (const c of d.contributions) {
      const heading = c.kindGroupLabel ?? pluralizeKindLabel(c.kindLabel);
      groups.set(heading, [...(groups.get(heading) ?? []), c]);
    }
    return html`
      <p class="pm-lead">Switch individual pieces of ${d.plugin.name} on or off. <b>Live</b> toggles apply immediately; <b>saved</b> ones are stored and take effect when that part of the plugin host ships.</p>
      <div data-contributions>
        ${[...groups].map(
          ([label, items]) => html`
            <h4 class="pm-group-h">${label} <span class="pm-count">${items.length}</span></h4>
            <div class="pm-contrib-grid">
              ${items.map((c) => {
                const blocked = c.offReason === "permission";
                return html`<div class="pm-contrib ${c.enabled ? "" : "off"}" data-contribution=${c.key}>
                  <span class="pm-contrib-ic" aria-hidden="true">${KIND_ICON[c.kind] ?? "◆"}</span>
                  <div class="pm-contrib-main">
                    <div class="pm-contrib-title">${c.label}</div>
                    ${c.detail ? html`<div class="pm-contrib-detail">${c.detail}</div>` : nothing}
                    <div class="pm-contrib-meta">
                      ${c.toggleable ? html`<span class="pp-pill ${c.live ? "live" : "saved"}">${c.live ? "live" : "saved"}</span>` : html`<span class="pp-pill" title="The host can't switch this off individually yet">always on</span>`}
                      ${c.requires.length ? html`<span>needs ${c.requires.join(", ")}</span>` : nothing}
                      ${blocked ? html`<span class="pm-warn-text">off — needs ${c.blockedBy?.join(", ")}</span>` : nothing}
                    </div>
                  </div>
                  ${c.toggleable
                    ? html`<button
                        class="pp-switch"
                        role="switch"
                        aria-checked=${String(c.enabled)}
                        aria-label=${`${c.kindLabel} ${c.label}: ${c.enabled ? "on" : "off"}`}
                        ?disabled=${blocked || this.busy.has(c.key)}
                        title=${blocked ? "Grant the permission first" : ""}
                        @click=${() => this.toggleContribution(c, !c.enabled)}
                      ></button>`
                    : nothing}
                </div>`;
              })}
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderPermissions(d: PluginDetail) {
    if (d.plugin.manifestVersion !== 2) {
      return html`<p class="pp-p pp-muted">v1 plugins run with full in-process access and don't declare permissions.</p>`;
    }
    if (!d.permissions.length) return html`<p class="pp-p pp-muted">${d.plugin.name} requests no permissions.</p>`;
    const sum = permissionSummary(d.permissions);
    const tierNote =
      d.plugin.tier === "community"
        ? "Community plugins run sandboxed; revoking removes access."
        : "In-process plugins can't be sandboxed yet: revoking turns off every part of the plugin that depends on the permission.";
    return html`
      <div class="pm-perm-sum" data-permission-summary>
        <span><b>${sum.requested}</b> requested</span>
        <span><b>${sum.granted}</b> granted</span>
        ${sum.high ? html`<span class="pm-risk r-high">${sum.high} high risk</span>` : nothing}
      </div>
      <p class="pm-lead">${tierNote} Changes apply immediately — no restart.</p>
      <div class="pm-perms" data-permissions data-learn-id="plugin-detail-permissions">
        ${sortPermissionsByRisk(d.permissions).map((perm) => {
          const copy = describePermission(perm);
          const consentAddsInfo = Boolean(perm.consent) && perm.consent !== copy.title && !(perm.value && perm.consent.toLowerCase().includes(perm.value.toLowerCase()));
          const platformBlocked = d.plugin.cloud?.blockedPermissions?.[perm.key];
          return html`<div class="pm-perm ${perm.granted ? "" : isDefaultOffPermission(perm) ? "default-off" : "revoked"}" data-permission=${perm.key}>
            <span class="pm-risk r-${copy.risk}">${RISK_LABEL[copy.risk]}</span>
            <div class="pm-perm-main">
              <div class="pm-perm-title">${copy.title}</div>
              <div class="pm-perm-explain">${copy.explain}${consentAddsInfo ? html` <span class="pp-muted">Publisher says: “${perm.consent}”</span>` : nothing}</div>
              <div class="pm-perm-meta">
                <span class="pp-code">${perm.key}</span>
                <span class=${perm.granted ? "pm-ok" : isDefaultOffPermission(perm) ? "pp-muted" : "pm-warn-text"} data-permission-status>${permissionStatusLabel(perm)}</span>
                ${perm.dependents.length
                  ? html`<span>${perm.granted ? "Revoking turns off" : "Turned off"}: ${perm.dependents.length} part${perm.dependents.length === 1 ? "" : "s"} <span class="pp-code">${perm.dependents.slice(0, 3).join(", ")}${perm.dependents.length > 3 ? "…" : ""}</span></span>`
                  : html`<span class="pp-muted">Nothing depends on it</span>`}
              </div>
              ${platformBlocked
                ? html`<div class="pm-perm-explain pm-warn-text" data-permission-blocked>${platformBlocked}</div>`
                : nothing}
            </div>
            <button
              class="pp-switch"
              role="switch"
              aria-checked=${String(perm.granted && !platformBlocked)}
              aria-label=${`${copy.title}: ${platformBlocked ? "not available on InfiniBot Cloud" : permissionStatusLabel(perm).toLowerCase()}`}
              ?disabled=${this.busy.has(perm.key) || Boolean(platformBlocked)}
              @click=${() => this.openModal({ kind: "permission", perm, granted: !perm.granted })}
            ></button>
          </div>`;
        })}
      </div>
    `;
  }

  private configDiff(): string[] {
    const cfg = this.config;
    return cfg ? configChanges(cfg.values, this.configDraft, cfg.secretKeys) : [];
  }

  private renderSettings(d: PluginDetail) {
    const cfg = this.config;
    if (!cfg) return html`<div class="sk w60"></div><div class="sk w90"></div><div class="sk w40"></div>`;
    const hasFields = Object.keys((cfg.schema?.properties ?? {}) as object).length > 0;
    const changed = new Set(this.configDiff());
    return html`
      ${renderPluginSettingsSections(this.selected(), this.gwClient())}
      ${hasFields && cfg.restartOnSave ? html`<p class="pm-lead">${d.restartNotes.config}</p>` : nothing}
      <div class="pm-form" data-settings-form>
        ${renderConfigForm({
          schema: cfg.schema,
          hints: cfg.uiHints,
          values: this.configDraft,
          savedValues: cfg.values,
          secretKeys: cfg.secretKeys,
          changed,
          onChange: (key, value) => {
            this.configDraft = setPath(this.configDraft, key, value);
          },
        })}
      </div>
    `;
  }

  private renderSaveBar() {
    const cfg = this.config;
    const changes = this.configDiff();
    if (!cfg || !changes.length) return nothing;
    const restart = cfg.restartOnSave;
    return html`<div class="pm-savebar" role="region" aria-label="Unsaved settings" data-savebar>
      <div class="pm-savebar-text">
        <b data-savebar-count>${changes.length} change${changes.length === 1 ? "" : "s"}</b>
        <span class="pm-savebar-keys" title=${changes.join(", ")}>${changes.join(", ")}</span>
        ${restart ? html`<span class="pm-savebar-warn">${ICONS.warn} Saving restarts the gateway</span>` : nothing}
      </div>
      <div class="pm-savebar-actions">
        <button class="pp-btn" @click=${() => (this.configDraft = { ...cfg.values })}>Discard</button>
        <button class="pp-btn primary" data-save-settings ?disabled=${this.busy.has("config")} @click=${() => (restart ? this.openModal({ kind: "config", values: this.configDraft }) : this.saveConfig(this.configDraft))}>${restart ? "Save & restart" : "Save"}</button>
      </div>
    </div>`;
  }
  private colorRow(label: string, key: "accent" | "tint", current: string, allowNone: boolean) {
    const custom = current.startsWith("#") ? current : "";
    return html`<div class="pp-field">
      <span class="pp-label">${label}</span>
      <div class="pp-color">
        ${allowNone
          ? html`<button class="pp-swatch" aria-pressed=${String(current === "none")} title="None" aria-label="No tint" style="background:repeating-linear-gradient(45deg,transparent 0 4px,var(--pp-line) 4px 5px)" @click=${() => this.updateAppearance(key, "none")}></button>`
          : nothing}
        ${ACCENT_TOKENS.map(
          (t) => html`<button
            class="pp-swatch"
            aria-pressed=${String(current === `token:${t}`)}
            title=${`InfiniBot ${t}`}
            aria-label=${`${label}: ${t}`}
            style="background:${TOKEN_SWATCH[t]}"
            @click=${() => this.updateAppearance(key, `token:${t}`)}
          ></button>`,
        )}
        <input
          type="color"
          class="pp-swatch"
          aria-label=${`${label}: custom colour`}
          aria-pressed=${String(Boolean(custom))}
          .value=${custom || "#22d3ee"}
          data-appearance-custom=${key}
          @input=${(e: Event) => this.updateAppearance(key, (e.target as HTMLInputElement).value)}
        />
        <span class="pp-code pp-muted">${current}</span>
      </div>
    </div>`;
  }

  private renderPreviewCard(a: ResolvedAppearance, theme: "dark" | "light", name: string) {
    const t = a.themes[theme];
    const style = Object.entries(t.vars)
      .map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, "")}`)
      .join(";");
    const mono = a.values.monogram ?? name.slice(0, 2).toUpperCase();
    return html`<div class="pp-preview ${theme}" data-preview=${theme} style=${style}>
      <div class="pp-pv-inner">
        <div class="pp-pv-top">
          <span class="pp-mono" style="--plugin-accent:${t.vars["--plugin-accent"] ?? ""}">${mono}</span>
          <div>
            <div class="pp-pv-title">${name}</div>
            <div class="pp-pv-accent">${theme === "dark" ? "Dark" : "Light"} theme · accent link</div>
          </div>
        </div>
        <div class="pp-pv-row" style="width:90%"></div>
        <div class="pp-pv-row" style="width:70%"></div>
        <div class="pp-pv-row" style="width:80%"></div>
        <span class="pp-pv-btn">Run now</span>
        <div class="pp-pv-meta">
          accent contrast ${t.contrast.accentOnSurface ?? "—"}:1${t.contrast.textOnSurface ? html` · text on tint ${t.contrast.textOnSurface}:1` : nothing}
        </div>
      </div>
    </div>`;
  }

  private renderAppearance(d: PluginDetail) {
    const a = this.appearancePreview ?? d.appearance;
    if (d.plugin.manifestVersion !== 2 || !a) {
      return html`<p class="pp-p pp-muted">Appearance settings are available for manifest-v2 plugins.</p>`;
    }
    const v = a.values;
    const defaults = a.defaults;
    return html`
      <div class="pp-note">Changes apply only inside ${d.plugin.name}'s own pages, widgets and panels — never to InfiniBot's core UI or other plugins — and follow the light/dark theme. Colours are checked against WCAG AA in both themes and adjusted when they'd be hard to read.</div>
      <div class="pp-app-grid">
        <div data-appearance-form>
          ${this.colorRow("Accent", "accent", v.accent, false)}
          ${this.colorRow("Surface tint", "tint", v.tint, true)}
          ${v.tint !== "none"
            ? html`<div class="pp-field">
                <label class="pp-label" for="tint-strength">Tint strength · ${Math.round(v.tintStrength * 100)}%</label>
                <input id="tint-strength" type="range" min="0" max="0.3" step="0.01" .value=${String(v.tintStrength)} @input=${(e: Event) => this.updateAppearance("tintStrength", Number((e.target as HTMLInputElement).value))} />
              </div>`
            : nothing}
          <div class="pp-field">
            <span class="pp-label">Density</span>
            <div class="pp-seg" role="group" aria-label="Density">
              ${(["comfortable", "compact"] as const).map(
                (dn) => html`<button aria-pressed=${String(v.density === dn)} @click=${() => this.updateAppearance("density", dn)}>${dn === "compact" ? "Compact" : "Comfortable"}</button>`,
              )}
            </div>
          </div>
          <div class="pp-field">
            <label class="pp-label" for="font-scale">Text size · ${Math.round(v.fontScale * 100)}%</label>
            <input id="font-scale" type="range" min="0.85" max="1.3" step="0.05" .value=${String(v.fontScale)} @input=${(e: Event) => this.updateAppearance("fontScale", Number((e.target as HTMLInputElement).value))} />
          </div>
          <div class="pp-field">
            <label class="pp-label" for="monogram">Monogram</label>
            <input id="monogram" class="pp-input" maxlength="3" style="max-width:90px" .value=${v.monogram ?? ""} placeholder=${defaults.monogram ?? ""} @input=${(e: Event) => this.updateAppearance("monogram", (e.target as HTMLInputElement).value.trim() || undefined)} />
          </div>
          ${defaults.layout.map(
            (l) => html`<div class="pp-field">
              <label class="pp-label" for=${`layout-${l.id}`}>${l.label}</label>
              ${l.type === "toggle"
                ? html`<button id=${`layout-${l.id}`} class="pp-switch" role="switch" aria-checked=${String(v.layout[l.id] === true)} @click=${() => this.updateAppearance("layout", { ...v.layout, [l.id]: !(v.layout[l.id] === true) })}></button>`
                : html`<select id=${`layout-${l.id}`} class="pp-select" style="max-width:220px" @change=${(e: Event) => this.updateAppearance("layout", { ...v.layout, [l.id]: (e.target as HTMLSelectElement).value })}>
                    ${l.options?.map((o) => html`<option value=${o.value} ?selected=${v.layout[l.id] === o.value}>${o.label}</option>`)}
                  </select>`}
            </div>`,
          )}
          ${defaults.variables.map(
            (x) => html`<div class="pp-field">
              <label class="pp-label" for=${`var-${x.name}`}>${x.label} <span class="pp-code pp-muted">${x.name}</span></label>
              ${x.type === "color"
                ? html`<input id=${`var-${x.name}`} type="color" class="pp-swatch" .value=${String(v.variables[x.name]).startsWith("#") ? String(v.variables[x.name]) : "#22c55e"} @input=${(e: Event) => this.updateAppearance("variables", { ...v.variables, [x.name]: (e.target as HTMLInputElement).value })} />`
                : x.type === "select"
                  ? html`<select id=${`var-${x.name}`} class="pp-select" style="max-width:220px" @change=${(e: Event) => this.updateAppearance("variables", { ...v.variables, [x.name]: (e.target as HTMLSelectElement).value })}>${x.options?.map((o) => html`<option ?selected=${v.variables[x.name] === o}>${o}</option>`)}</select>`
                  : html`<input id=${`var-${x.name}`} class="pp-input" style="max-width:140px" .value=${String(v.variables[x.name] ?? "")} @change=${(e: Event) => {
                      const raw = (e.target as HTMLInputElement).value;
                      this.updateAppearance("variables", { ...v.variables, [x.name]: x.type === "number" ? Number(raw) : raw });
                    }} />`}
            </div>`,
          )}
        </div>
        <div>
          <h4 class="pp-h">Live preview</h4>
          <div class="pp-previews">
            ${this.renderPreviewCard(a, "dark", d.plugin.name)}
            ${this.renderPreviewCard(a, "light", d.plugin.name)}
          </div>
          ${a.adjustments.length
            ? html`<div class="pp-note warn" style="margin-top:10px" data-contrast-adjustments>
                <b>Adjusted for readability</b>
                ${a.adjustments.map((x) => html`<div class="pp-code" style="margin-top:4px">${x.theme}: ${x.field} ${x.from} → ${x.to} (${x.reason})</div>`)}
              </div>`
            : html`<div class="pp-help" style="margin-top:8px">All colours pass WCAG AA in both themes.</div>`}
        </div>
      </div>
      <div class="pp-actions">
        <button class="pp-btn primary" data-appearance-save ?disabled=${!this.appearanceDirty || this.busy.has("appearance")} @click=${() => this.saveAppearance()}>Apply</button>
        <button class="pp-btn" ?disabled=${!this.appearanceDirty} @click=${() => {
          this.appearanceDirty = false;
          this.appearanceDraft = {};
          this.appearancePreview = d.appearance ?? null;
        }}>Discard</button>
        <button class="pp-btn" data-appearance-reset ?disabled=${!d.appearance?.customized || this.busy.has("appearance")} @click=${() => this.resetAppearance()}>Reset to defaults</button>
        <span class="pp-help">Applies live — no restart.</span>
      </div>
    `;
  }

  private renderHealth(d: PluginDetail) {
    const h = this.health;
    if (!h) return html`<div class="sk w60"></div><div class="sk w90"></div>`;
    return html`
      <div class="pp-section">
        <h4 class="pp-h">Status</h4>
        <dl class="pp-kv">
          <dt>Health</dt><dd><span class="pp-dot ${h.health.state}"></span> ${h.health.state}${h.health.reason ? html` — ${h.health.reason}` : nothing}</dd>
          <dt>Loader</dt><dd>${h.status}${h.error ? html` — ${h.error}` : nothing}</dd>
          <dt>RPC methods</dt><dd>${h.rpc.registered} registered / ${h.rpc.declared} declared${h.rpc.missing.length ? html` · missing ${h.rpc.missing.join(", ")}` : nothing}</dd>
          <dt>HTTP routes</dt><dd class="pp-code">${h.httpRoutes.join(", ") || "none"}</dd>
          <dt>Agent tools</dt><dd>${h.tools.join(", ") || "none"}</dd>
        </dl>
      </div>
      <div class="pp-section">
        <h4 class="pp-h">Services & sidecars</h4>
        ${h.services.length || h.sidecars.length
          ? html`<div class="pp-rows">
              ${h.services.map(
                (s) => html`<div class="pp-row"><div><div class="pp-row-title">${s.id}</div><div class="pp-row-sub"><span class="pp-dot ${s.running ? "ok" : s.lastError ? "error" : "off"}"></span>${s.running ? `running since ${formatTime(s.startedAt ?? Date.now())}` : "stopped"}${s.lastError ? html` · ${s.lastError}` : nothing}</div></div><span class="pp-pill">service</span></div>`,
              )}
              ${h.sidecars.map((s) => html`<div class="pp-row"><div><div class="pp-row-title">${s.id}</div><div class="pp-row-sub">${s.image ?? ""} · ${s.note}</div></div><span class="pp-pill">sidecar</span></div>`)}
            </div>`
          : html`<p class="pp-p pp-muted">No services or sidecars.</p>`}
        <div class="pp-actions">
          <button class="pp-btn" data-restart-plugin ?disabled=${d.plugin.status !== "loaded" || this.busy.has("restart")} @click=${() => this.restartServices(false)}>Restart plugin services</button>
          <button class="pp-btn danger" @click=${() => this.openModal({ kind: "reload" })}>Full reload…</button>
          <span class="pp-help">Restarting services is live; a full reload restarts the gateway.</span>
        </div>
      </div>
      ${h.diagnostics.length || d.listingWarnings?.length
        ? html`<div class="pp-section"><h4 class="pp-h">Diagnostics</h4>${h.diagnostics.map((x) => html`<div class="pp-note ${x.level === "error" ? "err" : "warn"}">${x.message}</div>`)}${(d.listingWarnings ?? []).map((w) => html`<div class="pp-note warn" data-listing-warning>Store listing: ${w}</div>`)}</div>`
        : nothing}
      <div class="pp-section">
        <h4 class="pp-h" style="display:flex;justify-content:space-between;align-items:center">Recent log lines <button class="pp-btn" @click=${() => this.reloadLogs()}>Refresh</button></h4>
        <div class="pp-logs" data-plugin-logs>
          ${this.logs.length
            ? [...this.logs].reverse().map(
                (l) => html`<div class="pp-log"><span class="pp-muted">${formatTime(l.ts)}</span><span class="lvl lvl-${l.level}">${l.level}</span><span class="msg">${l.message}</span></div>`,
              )
            : html`<span class="pp-muted">No log lines yet.</span>`}
        </div>
      </div>
    `;
  }

  private renderData(d: PluginDetail) {
    const busy = this.busy.has("data");
    return html`
      <div class="pp-section">
        <h4 class="pp-h">Storage</h4>
        <dl class="pp-kv">
          <dt>Size</dt><dd data-data-size>${formatBytes(d.data.bytes)} in ${d.data.files} file(s)</dd>
          <dt>Folder</dt><dd class="pp-code">${d.data.dir}${d.data.exists ? nothing : html` <span class="pp-muted">(not created yet)</span>`}</dd>
        </dl>
        <div class="pp-actions">
          <button class="pp-btn" ?disabled=${busy || d.data.files === 0} @click=${() => this.exportData()}>Export…</button>
          <label class="pp-btn" style="display:inline-flex;align-items:center">Import backup…<input type="file" accept="application/json,.json" hidden @change=${(e: Event) => this.importFile(e)} /></label>
          <div class="pp-seg" role="group" aria-label="Import mode">
            ${(["merge", "replace"] as const).map((m) => html`<button aria-pressed=${String(this.dataImportMode === m)} @click=${() => (this.dataImportMode = m)}>${m}</button>`)}
          </div>
          <button class="pp-btn danger" ?disabled=${busy || !d.data.exists} @click=${() => this.openModal({ kind: "clear" })}>Clear data…</button>
        </div>
      </div>
      <div class="pp-section">
        <h4 class="pp-h">Importers</h4>
        ${d.importers.length
          ? html`<div class="pp-rows">${d.importers.map(
              (imp) => html`<div class="pp-row"><div><div class="pp-row-title">${imp.label}</div><div class="pp-row-sub">${imp.description ?? ""} <span class="pp-code">${imp.method}</span></div></div>
                ${imp.input === "none"
                  ? html`<button class="pp-btn" data-importer=${imp.id} ?disabled=${d.plugin.status !== "loaded" || this.busy.has("data")} @click=${() => this.runImporter(imp.id, imp.label)}>Run import</button>`
                  : html`<label class="pp-btn" data-importer=${imp.id} style="display:inline-flex;align-items:center">Choose file…<input type="file" accept=${imp.accept ?? ""} hidden ?disabled=${d.plugin.status !== "loaded"} @change=${(e: Event) => this.importFile(e, imp.id)} /></label>`}</div>`,
            )}</div>`
          : html`<p class="pp-p pp-muted">${d.plugin.name} declares no importers.</p>`}
      </div>
    `;
  }

  private renderVersions(d: PluginDetail) {
    return this.pk.renderVersions(d);
  }

  private renderUninstall(d: PluginDetail) {
    const p = d.plugin;
    return html`
      <div class="pm-danger-zone">
      <p class="pp-p">Uninstalling ${p.name} removes it from this gateway: its nav entries, pages, RPCs, tools and settings go away. ${p.origin === "bundled" ? "It ships with InfiniBot, so it stays listed (turned off) and can be turned back on later." : ""}</p>
      <div class="pp-note warn">${d.restartNotes.uninstall}</div>
      <label class="pp-radio"><input type="radio" name="keep" .checked=${this.uninstallKeepData} @change=${() => (this.uninstallKeepData = true)} /><span><b>Keep its data</b><br /><span class="pp-muted">${formatBytes(d.data.bytes)} stays in <span class="pp-code">${d.data.dir}</span> for a reinstall.</span></span></label>
      <label class="pp-radio"><input type="radio" name="keep" .checked=${!this.uninstallKeepData} @change=${() => (this.uninstallKeepData = false)} /><span><b>Remove its data</b><br /><span class="pp-muted">Deletes the folder permanently.</span></span></label>
      <div class="pp-actions"><button class="pp-btn danger solid" data-uninstall @click=${() => this.openModal({ kind: "uninstall", keepData: this.uninstallKeepData })}>Uninstall ${p.name}…</button></div>
      </div>
    `;
  }

  private renderDetailSection(id: DetailSectionId, title: string, body: TemplateResult | typeof nothing, extra?: TemplateResult) {
    return html`<section class="pm-dsec" id=${`sec-${id}`} data-section=${id} data-learn-id=${`plugin-section-${id}`} tabindex="-1" aria-labelledby=${`sech-${id}`}>
      <div class="pm-dsec-head"><h2 class="pm-dsec-title" id=${`sech-${id}`}>${title}</h2>${extra ?? nothing}</div>
      ${body}
    </section>`;
  }

  private renderDetail() {
    const p = this.selected();
    if (!p) {
      return html`<div class="pm-detail-missing">
        <button class="pm-back" @click=${() => this.select(null)}>${ICONS.back} All plugins</button>
        <div class="pm-empty"><h3>${this.loaded ? `Plugin “${this.selectedId}” isn't installed` : "Loading…"}</h3></div>
      </div>`;
    }
    const d = this.detail && this.detail.plugin.id === p.id ? this.detail : null;
    const note = this.notes.get(p.id);
    const cover = this.coverSrc(p);
    const perms = d ? permissionSummary(d.permissions) : null;
    const sections = DETAIL_SECTIONS.map((s) => ({
      ...s,
      badge:
        s.id === "permissions" && perms?.requested
          ? `${perms.granted}/${perms.requested}`
          : s.id === "settings" && this.configDiff().length
            ? `${this.configDiff().length}`
            : s.id === "contributions" && d?.contributions.length
              ? `${d.contributions.length}`
              : undefined,
    }));
    return html`
      <article class="pm-detail" data-plugin-detail=${p.id} aria-label=${`${p.name} details`}>
        ${renderDetailHero({
          name: p.name,
          cover,
          onCoverError: () => this.markBroken(p.listing?.cover),
          icon: this.iconOf(p),
          kicker: categoryLabel(categoryOf(p)),
          tagline: this.taglineOf(p),
          meta: html`${this.renderTier(p)}${this.pu.renderBadges(p)}${this.renderVaultBadge(p)}<span>${this.publisherOf(p)}</span>${p.version ? html`<span>v${p.version}</span>` : nothing}${this.renderStatus(p)}`,
          actions: html`${this.renderTourButton(p, "lg")}
            ${p.enabled || accessBlock(p) ? this.renderPrimaryButton(p, "lg") : nothing}
            ${accessBlock(p) && !p.enabled
              ? nothing
              : html`<div class="pm-onoff" data-learn-id="plugin-detail-onoff" data-ib-target=${`plugin:${p.id}/enable`}>${this.renderSwitch(p, true)}</div>`}`,
          backLabel: "All plugins",
          onBack: () => void this.select(null),
        })}

        ${note ? html`<div class="pp-note ${note.kind ?? ""} pm-dnote" data-plugin-note role="status">${note.text}</div>` : nothing}
        ${this.detailError ? html`<div class="pp-note err pm-dnote">${this.detailError}</div>` : nothing}
        ${cloudBlock(p)
          ? html`<div class="pm-cloud-note" data-cloud-status=${p.cloud?.status ?? ""} role="note">
              <div><strong>${cloudBlock(p)!.label}</strong>${cloudBlock(p)!.detail ?? ""}${p.cloud?.status === "locked" && p.cloud.plan ? html` <span class="pp-muted">Current plan: ${p.cloud.plan}.</span>` : nothing}</div>
            </div>`
          : nothing}
        ${cloudSelfHostFeatures(p).length
          ? html`<div class="pm-cloud-note" data-cloud-partial role="note">
              <div><strong>Works on InfiniBot Cloud, except:</strong>
                <ul class="pm-cloud-features">${cloudSelfHostFeatures(p).map((f) => html`<li data-self-host-feature=${f.feature}><b>${f.feature}</b> <span class="pp-muted">(self-hosted only) ${f.why}</span></li>`)}</ul>
              </div>
            </div>`
          : nothing}
        ${accessBlock(p) && !p.enabled ? this.pu.renderAccessCallout(p) : nothing}
        ${!p.enabled && !this.pending.has(p.id) && !cloudBlock(p) && !accessBlock(p)
          ? html`<div class="pm-enable-cta">
              ${this.gateOf(p)
                ? html`<div data-paid-cta><b>${p.name} is a paid plugin (${this.gateOf(p)!.entry.priceLabel}).</b> <span class="pp-muted">${this.gateOf(p)!.kind === "external"
                    ? `Sold by ${this.gateOf(p)!.entry.publisher.name}: buy it on their page.`
                    : this.gateOf(p)!.vault
                      ? `${VAULT_INCLUDED_LABEL}: unlock it with every other InfiniBot plugin on KinglyVault, or buy just this one.`
                      : "Buy it once on the InfiniBot marketplace, then turn it on here."}</span>${this.gateOf(p)!.vault ? html` ${this.renderVaultDownloads()}` : nothing}</div>`
                : html`<div><b>${p.name} is off.</b> <span class="pp-muted">Turning it on restarts the gateway to load its code (a few seconds).</span></div>`}
              <span class="pm-enable-actions">${this.renderPrimaryButton(p, "lg")}</span>
            </div>`
          : nothing}

        <nav class="pm-dnav" aria-label="Sections" data-learn-id="plugin-detail-nav">
          ${sections.map(
            (s) => html`<a
              href=${`#sec-${s.id}`}
              class="pm-dnav-link"
              aria-current=${this.section === s.id ? "true" : "false"}
              data-tab=${s.id}
              data-learn-id=${`plugin-tab-${s.id}`}
              @click=${(e: Event) => {
                e.preventDefault();
                this.goToSection(s.id);
              }}
            >${s.label}${s.badge ? html`<span class="pm-dnav-badge">${s.badge}</span>` : nothing}</a>`,
          )}
        </nav>

        ${d
          ? html`
              <div class="pm-dgrid">
                <div class="pm-dmain">
                  ${this.renderDetailSection("overview", "Overview", this.renderOverview(d))}
                  ${this.renderDetailSection("contributions", "What it adds", this.renderContributions(d))}
                  ${this.renderDetailSection("permissions", "Permissions", this.renderPermissions(d))}
                  ${this.renderDetailSection("settings", "Settings", this.renderSettings(d))}
                  ${this.renderDetailSection("appearance", "Appearance", this.renderAppearance(d))}
                  ${this.renderDetailSection("health", "Health & Logs", this.renderHealth(d))}
                  ${this.renderDetailSection("data", "Data", this.renderData(d))}
                  ${this.renderDetailSection("versions", "Versions", this.renderVersions(d))}
                  ${this.renderDetailSection("uninstall", "Uninstall", this.renderUninstall(d))}
                </div>
                <aside class="pm-dside" aria-label="About ${p.name}">
                  <h2 class="pm-side-h">About</h2>
                  ${this.renderFacts(d)}
                </aside>
              </div>
              ${this.renderSaveBar()}
            `
          : html`<div class="pm-dloading" aria-busy="true"><div class="sk w60"></div><div class="sk w90"></div><div class="sk w90"></div><div class="sk w40"></div></div>`}
      </article>
    `;
  }

  private renderLightbox() {
    const lb = this.lightbox;
    if (!lb) return nothing;
    const img = lb.images[lb.index];
    if (!img) return nothing;
    const many = lb.images.length > 1;
    return html`<div class="pm-lb" role="dialog" aria-modal="true" aria-label=${`Screenshot ${lb.index + 1} of ${lb.images.length}`} data-lightbox @click=${(e: Event) => e.target === e.currentTarget && this.closeLightbox()}>
      <button class="pm-lb-close" aria-label="Close screenshot" @click=${() => this.closeLightbox()}>${ICONS.close}</button>
      ${many ? html`<button class="pm-lb-nav prev" aria-label="Previous screenshot" @click=${() => this.stepLightbox(-1)}>${ICONS.prev}</button>` : nothing}
      <figure class="pm-lb-fig">
        <img src=${this.img(img.src) ?? ""} alt=${img.caption ?? `Screenshot ${lb.index + 1}`} />
        <figcaption>${img.caption ?? ""}${many ? html`<span class="pm-lb-count">${lb.index + 1} / ${lb.images.length}</span>` : nothing}</figcaption>
      </figure>
      ${many ? html`<button class="pm-lb-nav next" aria-label="Next screenshot" @click=${() => this.stepLightbox(1)}>${ICONS.next}</button>` : nothing}
    </div>`;
  }
  // ── modals ──────────────────────────────────────────────────────────

  private subagentWarning() {
    if (this.runningSubagents === null) return html`<p class="pp-help">Checking for running sub-agents…</p>`;
    if (this.runningSubagents === 0) return html`<p class="pp-help">No sub-agents are running.</p>`;
    return html`<div class="pp-note warn" data-subagent-warning><b>${this.runningSubagents} sub-agent${this.runningSubagents === 1 ? " is" : "s are"} running.</b> The restart stops ${this.runningSubagents === 1 ? "it" : "them"}; wait for ${this.runningSubagents === 1 ? "it" : "them"} to finish if the work matters.</div>`;
  }

  private renderModal() {
    const m = this.modal;
    if (!m) return nothing;
    const close = () => (this.modal = null);
    let title = "";
    let body: TemplateResult = html``;
    let confirmLabel = "Confirm";
    let danger = false;
    let action: () => void = close;
    switch (m.kind) {
      case "enable":
        title = `${m.enabled ? "Turn on" : "Turn off"} ${m.plugin.name}?`;
        confirmLabel = m.enabled ? "Turn on & restart" : "Turn off & restart";
        body = html`<p class="pp-p">Turning a plugin ${m.enabled ? "on" : "off"} restarts the gateway so it can ${m.enabled ? "load" : "unload"} the plugin's code. Open connections reconnect automatically (a few seconds).</p>${this.subagentWarning()}<p class="pp-help">Tip: to hide a page or stop one tool without a restart, use “What it adds” on the plugin's page instead.</p>`;
        action = () => void this.setEnabled(m.plugin, m.enabled);
        danger = !m.enabled;
        break;
      case "config":
        title = "Save settings and reload?";
        confirmLabel = "Save & reload";
        body = html`<p class="pp-p">The plugin reads its settings when it loads, so saving restarts the gateway.</p>${this.subagentWarning()}`;
        action = () => void this.saveConfig(m.values);
        break;
      case "permission": {
        title = `${m.granted ? "Grant" : "Revoke"} permission?`;
        confirmLabel = m.granted ? "Grant" : "Revoke";
        danger = !m.granted;
        body = html`<p class="pp-p"><b>${m.perm.consent}</b></p>
          ${m.granted
            ? html`<p class="pp-p">${this.detail?.plugin.name} will be allowed to do this again, and the contributions that need it come back on.</p>`
            : html`<p class="pp-p">${m.perm.dependents.length ? html`This turns off: <span class="pp-code">${m.perm.dependents.join(", ")}</span>.` : "No declared contribution depends on it."}</p>`}
          <p class="pp-help">Applies immediately — no restart.</p>`;
        action = () => void this.setPermission(m.perm, m.granted);
        break;
      }
      case "reload":
        title = "Fully reload this plugin?";
        confirmLabel = "Reload & restart";
        danger = true;
        body = html`<p class="pp-p">A full reload re-runs the plugin's code, which restarts the gateway.</p>${this.subagentWarning()}`;
        action = () => void this.restartServices(true);
        break;
      case "clear":
        title = "Clear this plugin's data?";
        confirmLabel = "Clear data";
        danger = true;
        body = html`<p class="pp-p">Deletes everything in <span class="pp-code">${this.detail?.data.dir}</span> (${formatBytes(this.detail?.data.bytes ?? 0)}). Export first if you might need it.</p>`;
        action = () => void this.clearData();
        break;
      case "uninstall":
        title = `Uninstall ${this.detail?.plugin.name}?`;
        confirmLabel = m.keepData ? "Uninstall, keep data" : "Uninstall & delete data";
        danger = true;
        body = html`<p class="pp-p">${m.keepData ? "Its data is kept." : "Its data folder is deleted permanently."} The gateway restarts to unload the plugin.</p>${this.subagentWarning()}`;
        action = () => void this.uninstall(m.keepData);
        break;
    }
    return html`<div class="pp-modal-bg" @click=${(e: Event) => e.target === e.currentTarget && close()}>
      <div class="pp-modal" role="dialog" aria-modal="true" aria-label=${title} data-modal=${m.kind} tabindex="-1">
        <h3>${title}</h3>
        ${body}
        <div class="pp-actions" style="justify-content:flex-end">
          <button class="pp-btn" @click=${close}>Cancel</button>
          <button class="pp-btn ${danger ? "danger solid" : "primary"}" data-modal-confirm @click=${() => {
            close();
            action();
          }}>${confirmLabel}</button>
        </div>
      </div>
    </div>`;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("loaded") || changed.has("selectedId")) this.measureStickyTop();
    if (changed.has("modal") && this.modal) {
      this.renderRoot.querySelector<HTMLElement>("[data-modal-confirm]")?.focus();
    }
    // Keep the active section link visible in the horizontally scrolling nav (390px).
    if (changed.has("section")) {
      const active = this.renderRoot.querySelector<HTMLElement>('.pm-dnav-link[aria-current="true"]');
      const strip = active?.parentElement;
      if (active && strip && strip.scrollWidth > strip.clientWidth) {
        const left = active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2;
        strip.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }
    }
  }

  // ── render ──────────────────────────────────────────────────────────

  /** A Marketplace listing's detail page is open (the Installed detail wins when both are). */
  private marketDetailOpen(): boolean {
    return this.pk.tab === "marketplace" && Boolean(this.pk.detailId);
  }

  override render() {
    return html`
      <div class="pm-page ${this.selectedId || this.marketDetailOpen() ? "is-detail" : "is-browse"}">
        ${this.selectedId ? this.renderDetail() : this.marketDetailOpen() ? this.pk.renderMarketDetail() : this.renderBrowse()}
      </div>
      ${this.renderLightbox()}
      ${this.renderModal()}
      ${this.pk.renderOverlays()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "plugins-view": PluginsView;
  }
}

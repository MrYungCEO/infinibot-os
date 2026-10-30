/**
 * Plugins page — paid plugins: catalog extras (Recommended, badges), the
 * Purchases tab (KinglyVault account, restore, manage), Buy / Connect flows
 * and the locked-plugin call-out on the detail page.
 *
 * Connect: <ib-kv-connect> (device code, approved in the normal browser; the
 * gateway polls KinglyVault and imports the signed token itself).
 *
 * Buy: opens the plugin's KinglyVault page in the normal browser. When this
 * install is connected, the page then re-syncs every 15 s for 10 minutes, so
 * the plugin unlocks on its own after checkout. Owned, included (plan, owner
 * licence) and free plugins never show Buy.
 *
 * Older KinglyVault (no device flow): Buy / Restore fall back to the same-tab
 * redirect: `return=<this page>` + one-time `state`, back to
 * `<this page>#kv=<base64url JSON {token, refreshToken, apiUrl, state, plugin}>`;
 * consumeReturnFragment() checks the state and imports it. The gateway
 * verifies the RS256 signature itself; the page never trusts the token.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { KvStatus } from "../../components/kv-connect-model.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import type {
  CatalogPluginUi,
  EntitlementSummary,
  PluginCatalog,
  PluginSummary,
  PurchaseUrls,
} from "./api.js";

type Host = {
  rpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  update: () => void;
  refresh: () => Promise<void>;
  plugins: () => PluginSummary[];
  open: (id: string) => void;
  client: () => GatewayBrowserClient | null;
};

/** What a card says about price: exactly one of Free / Included / Owned / Buy. */
export type PriceTag = { kind: "free" | "included" | "owned" | "buy"; label: string; title: string };

export function priceTag(p: PluginSummary): PriceTag | null {
  const a = p.access;
  // Hosted cloud: a plugin the plan doesn't allow shows the cloud badge instead.
  if (p.cloud && !p.cloud.loadable) return null;
  if (!a || !a.requires.purchase) return { kind: "free", label: "Free", title: "Free plugin" };
  if (a.loadable) {
    const bought = a.source === "purchase" || a.source === "sandbox";
    return bought
      ? { kind: "owned", label: "Owned", title: sourceLabel(a.source) }
      : { kind: "included", label: includedLabel(a.source), title: a.source ? sourceLabel(a.source) : "Included in your plan" };
  }
  return {
    kind: "buy",
    label: a.price ? `Buy ${a.price.label}` : "Buy",
    title: a.reason ?? "Paid plugin",
  };
}

const WATCH_EVERY_MS = 15_000;
const WATCH_FOR_MS = 10 * 60_000;

const STATE_KEY = "infinibot.plugins.kvState";

const ICON = {
  lock: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`,
  crown: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z" /></svg>`,
  link: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>`,
  check: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>`,
  spark: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></svg>`,
  refresh: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>`,
  external: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>`,
};
export const PURCHASE_ICONS = ICON;

const SOURCE_LABEL: Record<string, string> = {
  purchase: "Purchased",
  sandbox: "Test purchase",
  admin: "Included (admin)",
  "admin:owner": "Owner licence",
  "plan:ceo": "Included with your CEO plan",
  "plan:vip": "Included with your plan",
  "plan:gold": "Included with your CEO plan",
  "plan:owner": "Included with your CEO plan",
};

const OWNED_SOURCES = new Set(["purchase", "sandbox"]);

/** Cover/price badge for a plan unlock ("Included with your CEO plan"). */
export function includedLabel(src: string | undefined): string {
  return src && /^plan:(ceo|gold|owner)$/.test(src) ? "Included with your CEO plan" : "Included";
}

export function sourceLabel(src: string | undefined): string {
  return (src && SOURCE_LABEL[src]) || "Unlocked";
}

/** Decode the KinglyVault return fragment (`#kv=…`), or null. Exported for tests. */
export function parseReturnFragment(hash: string): {
  token: string;
  refreshToken?: string;
  apiUrl?: string;
  state?: string | null;
  plugin?: string | null;
} | null {
  const m = /(?:^#|&)kv=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const v = JSON.parse(json) as Record<string, unknown>;
    if (typeof v.token !== "string") return null;
    return {
      token: v.token,
      refreshToken: typeof v.refreshToken === "string" ? v.refreshToken : undefined,
      apiUrl: typeof v.apiUrl === "string" ? v.apiUrl : undefined,
      state: typeof v.state === "string" ? v.state : null,
      plugin: typeof v.plugin === "string" ? v.plugin : null,
    };
  } catch {
    return null;
  }
}

function newState(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class PluginPurchases {
  catalog: PluginCatalog | null = null;
  summary: EntitlementSummary | null = null;
  busy: string | null = null;
  note: { kind: "ok" | "error" | "info"; text: string } | null = null;
  /** plugins.kv.status (null = not loaded / older gateway). */
  kv: KvStatus | null = null;
  /** Plugin bought in the browser that we're waiting to unlock. */
  watching: { id: string; until: number } | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: Host) {}

  byId(id: string): CatalogPluginUi | undefined {
    return this.catalog?.plugins.find((p) => p.id === id);
  }

  async load(): Promise<void> {
    try {
      const [catalog, summary, kv] = await Promise.all([
        this.host.rpc<PluginCatalog>("plugins.catalog").catch(() => null),
        this.host.rpc<EntitlementSummary>("plugins.entitlements.status").catch(() => null),
        this.host.rpc<KvStatus>("plugins.kv.status").catch(() => null),
      ]);
      if (catalog) this.catalog = catalog;
      if (summary) this.summary = summary;
      this.kv = kv;
      this.host.update();
    } catch {
      /* older gateway: no catalog — the page works without it */
    }
  }

  /** Back from KinglyVault: import the token in the fragment (once). */
  async consumeReturnFragment(): Promise<void> {
    const parsed = parseReturnFragment(window.location.hash);
    if (!parsed) return;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url.toString());
    const expected = sessionStorage.getItem(STATE_KEY);
    if (!expected || parsed.state !== expected) {
      this.note = {
        kind: "error",
        text: "That KinglyVault link was not started from this page, so it was ignored. Use Connect KinglyVault to try again.",
      };
      this.host.update();
      return;
    }
    sessionStorage.removeItem(STATE_KEY);
    this.busy = "import";
    this.host.update();
    try {
      const res = await this.host.rpc<{ changed: string[]; restart: { plugins?: string[] } | null; summary: EntitlementSummary }>(
        "plugins.entitlements.import",
        { token: parsed.token, refreshToken: parsed.refreshToken, apiUrl: parsed.apiUrl },
      );
      this.summary = res.summary;
      const names = res.changed.filter((c) => c !== "*").map((id) => this.host.plugins().find((p) => p.id === id)?.name ?? id);
      this.note = {
        kind: "ok",
        text:
          res.changed.includes("*")
            ? "KinglyVault connected. Your plan includes every paid plugin."
            : names.length
              ? `KinglyVault connected. Unlocked: ${names.join(", ")}.`
              : "KinglyVault connected. Your purchases are up to date.",
      };
      if (res.restart) this.note.text += " The gateway is restarting to load them.";
      await this.host.refresh();
      await this.load();
      if (parsed.plugin && this.host.plugins().some((p) => p.id === parsed.plugin)) this.host.open(parsed.plugin);
    } catch (err) {
      this.note = { kind: "error", text: `Couldn't use that KinglyVault link: ${String((err as Error)?.message ?? err)}` };
    } finally {
      this.busy = null;
      this.host.update();
    }
  }

  private returnUrl(): string {
    const u = new URL(window.location.href);
    u.hash = "";
    u.search = "";
    return u.toString();
  }

  private async urls(id?: string): Promise<PurchaseUrls & { state: string }> {
    const state = newState();
    sessionStorage.setItem(STATE_KEY, state);
    const urls = await this.host.rpc<PurchaseUrls>("plugins.purchase.urls", { id, returnUrl: this.returnUrl(), state });
    return { ...urls, state };
  }

  /** The device flow is live (connect + automatic sync after a purchase). */
  get deviceFlow(): boolean {
    return Boolean(this.kv?.capabilities.available);
  }

  get linked(): boolean {
    return Boolean(this.summary?.linked ?? this.kv?.account.linked);
  }

  /**
   * Buy in the normal browser. Connected: re-sync until it unlocks. Older
   * KinglyVault without the device flow: the same-tab redirect, as before.
   */
  async buy(id: string): Promise<void> {
    const name = this.host.plugins().find((p) => p.id === id)?.name ?? id;
    this.busy = `buy:${id}`;
    this.host.update();
    try {
      if (!this.deviceFlow) {
        const u = await this.urls(id);
        if (u.buy) window.location.assign(u.buy);
        return;
      }
      const u = await this.host.rpc<PurchaseUrls>("plugins.purchase.urls", { id });
      if (u.buy) window.open(u.buy, "_blank", "noopener,noreferrer");
      if (this.linked) {
        this.note = { kind: "info", text: `Finish buying ${name} in your browser. It unlocks here by itself once KinglyVault confirms the payment.` };
        this.watch(id);
      } else {
        this.note = { kind: "info", text: `Finish buying ${name} in your browser, then connect KinglyVault (Purchases tab, or the panel on ${name}) and it unlocks here.` };
      }
    } catch (err) {
      this.note = { kind: "error", text: `Couldn't open KinglyVault: ${String((err as Error)?.message ?? err)}` };
    } finally {
      this.busy = null;
      this.host.update();
    }
  }

  /** After a purchase in the browser: re-sync until the plugin unlocks (or 10 min). */
  watch(id: string): void {
    this.stopWatching();
    this.watching = { id, until: Date.now() + WATCH_FOR_MS };
    const tick = async () => {
      const w = this.watching;
      if (!w) return;
      try {
        await this.host.rpc("plugins.entitlements.refresh");
        await this.host.refresh();
        await this.load();
      } catch {
        // gateway restarting after an unlock: next tick
      }
      const p = this.host.plugins().find((x) => x.id === w.id);
      if (p?.access?.loadable) {
        this.note = { kind: "ok", text: `${p.name} is unlocked. Turn it on whenever you like.` };
        this.stopWatching();
        this.host.update();
        return;
      }
      if (Date.now() > w.until) {
        this.note = { kind: "info", text: "Still waiting for KinglyVault to confirm the purchase. Press Sync now on the Purchases tab once it has gone through." };
        this.stopWatching();
        this.host.update();
        return;
      }
      this.watchTimer = setTimeout(() => void tick(), WATCH_EVERY_MS);
    };
    this.watchTimer = setTimeout(() => void tick(), WATCH_EVERY_MS);
  }

  stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watching = null;
  }

  /** <ib-kv-connect> linked / synced / disconnected: reload what's unlocked. */
  async afterKvChange(): Promise<void> {
    await this.host.refresh();
    await this.load();
    this.host.update();
  }

  private renderConnect(variant: "card" | "compact"): TemplateResult {
    return html`<ib-kv-connect .client=${this.host.client()} variant=${variant} data-kv-panel=${variant}
      @kv-changed=${() => void this.afterKvChange()}></ib-kv-connect>`;
  }

  async connect(pluginId?: string): Promise<void> {
    this.busy = "connect";
    this.host.update();
    try {
      const u = await this.urls(pluginId);
      window.location.assign(u.link);
    } catch (err) {
      this.note = { kind: "error", text: `Couldn't open KinglyVault: ${String((err as Error)?.message ?? err)}` };
      this.busy = null;
      this.host.update();
    }
  }

  async refreshNow(): Promise<void> {
    this.busy = "refresh";
    this.host.update();
    try {
      const res = await this.host.rpc<{ ok: boolean; error?: string; summary: EntitlementSummary; restart: unknown }>(
        "plugins.entitlements.refresh",
      );
      this.summary = res.summary;
      this.note = res.ok
        ? { kind: "ok", text: `Purchases re-checked with KinglyVault.${res.restart ? " The gateway is restarting to apply changes." : ""}` }
        : { kind: "error", text: res.error ?? "Couldn't reach KinglyVault." };
      await this.host.refresh();
      await this.load();
    } catch (err) {
      this.note = { kind: "error", text: String((err as Error)?.message ?? err) };
    } finally {
      this.busy = null;
      this.host.update();
    }
  }

  async unlink(): Promise<void> {
    if (!confirm("Disconnect KinglyVault from this InfiniBot? Paid plugins lock until you connect again.")) return;
    this.busy = "unlink";
    this.host.update();
    try {
      const res = await this.host.rpc<{ summary: EntitlementSummary; restart: unknown }>("plugins.entitlements.unlink");
      this.summary = res.summary;
      this.note = { kind: "info", text: `KinglyVault disconnected.${res.restart ? " The gateway is restarting." : ""}` };
      await this.host.refresh();
      await this.load();
    } finally {
      this.busy = null;
      this.host.update();
    }
  }

  // ── render ─────────────────────────────────────────────────────────

  renderNote(): TemplateResult | typeof nothing {
    if (!this.note) return nothing;
    return html`<div class="pu-note k-${this.note.kind}" role=${this.note.kind === "error" ? "alert" : "status"} data-purchase-note>
      <span>${this.note.text}</span>
      <button class="pm-link" @click=${() => { this.note = null; this.host.update(); }}>Dismiss</button>
    </div>`;
  }

  /** Recommended-for-you strip above the Installed results. */
  renderRecommended(renderCard: (p: PluginSummary) => TemplateResult): TemplateResult | typeof nothing {
    const c = this.catalog;
    if (!c?.recommended.length) return nothing;
    const plugins = c.recommended
      .map((id) => this.host.plugins().find((p) => p.id === id))
      .filter((p): p is PluginSummary => Boolean(p));
    if (!plugins.length) return nothing;
    const reasons = this.byId(plugins[0].id)?.recommended?.reasons ?? [];
    return html`<section class="pm-section pu-reco" aria-labelledby="reco-h" data-recommended>
      <div class="pm-section-head">
        <div>
          <h2 id="reco-h" class="pm-section-title"><span class="pu-ic">${ICON.spark}</span>Recommended for you</h2>
          <p class="pm-section-blurb">${c.profile.source === "onboarding"
            ? `Picked from what you told InfiniBot during setup${c.profile.useCases.length ? ` (${c.profile.useCases.slice(0, 3).join(", ")})` : ""}.`
            : reasons[0] ?? "A good place to start."}</p>
        </div>
      </div>
      <div class="pm-grid">${plugins.slice(0, 4).map((p) => renderCard(p))}</div>
    </section>`;
  }

  /** Cover badges: New, and exactly one of Free / Included / Owned / Buy. */
  renderBadges(p: PluginSummary): TemplateResult | typeof nothing {
    const isNew = this.byId(p.id)?.badges.includes("new");
    const parts: TemplateResult[] = [];
    if (isNew) parts.push(html`<span class="pu-badge b-new" data-badge="new">New</span>`);
    // status "free" on a paid plugin = the hosted cloud plan governs it (no KinglyVault gate here).
    const tag = p.access?.requires.purchase && p.access.status === "free" ? null : priceTag(p);
    if (tag) {
      const cls = tag.kind === "buy" ? "b-paid" : tag.kind === "free" ? "b-free" : "b-owned";
      const icon = tag.kind === "buy" ? ICON.lock : tag.kind === "included" ? ICON.crown : tag.kind === "owned" ? ICON.check : nothing;
      parts.push(html`<span class="pu-badge ${cls}" data-badge=${tag.kind} title=${tag.title}>${icon}${tag.label}</span>`);
    }
    return parts.length ? html`<span class="pu-cover-badges">${parts}</span>` : nothing;
  }

  /** Detail page: the lock / ownership call-out for a gated plugin. */
  renderAccessCallout(p: PluginSummary): TemplateResult | typeof nothing {
    const a = p.access;
    if (!a || !a.requires.purchase || a.status === "free") return nothing;
    if (a.loadable) {
      return html`<div class="pu-callout k-owned" data-access-callout="owned">
        <span class="pu-callout-ic">${a.source?.startsWith("plan:") || a.source === "admin:owner" ? ICON.crown : ICON.check}</span>
        <div class="pu-callout-main">
          <strong>${sourceLabel(a.source)}</strong>
          <p>${a.status === "grace"
            ? `InfiniBot can't reach KinglyVault right now, so it is using your saved purchase until ${a.graceEndsAt ? new Date(a.graceEndsAt).toLocaleDateString() : "the grace period ends"}.`
            : a.source === "admin:owner"
              ? "Unlocked by this machine's signed owner licence. Turn it on whenever you like."
              : "Verified with KinglyVault. Turn it on whenever you like."}</p>
        </div>
      </div>`;
    }
    const busyBuy = this.busy === `buy:${p.id}`;
    return html`<div class="pu-callout k-paid" data-access-callout="paid">
      <span class="pu-callout-ic">${ICON.lock}</span>
      <div class="pu-callout-main">
        <strong>${a.status === "expired" ? "Reconnect KinglyVault to keep using it" : `Paid plugin${a.price ? ` · ${a.price.label} one-time` : ""}`}</strong>
        <p>${a.status === "expired" ? a.reason : this.deviceFlow ? "Buy it once on KinglyVault, or unlock every paid plugin with the CEO plan." : "Buy it once on KinglyVault, or unlock every paid plugin with the CEO plan. Already bought it? Restore your purchase."}</p>
      </div>
      <div class="pu-callout-actions">
        <button class="pm-action primary" data-buy=${p.id} ?disabled=${Boolean(this.busy)} @click=${() => void this.buy(p.id)}>
          ${busyBuy ? "Opening…" : a.price ? `Buy · ${a.price.label}` : "Buy"}
        </button>
        ${this.deviceFlow
          ? nothing
          : html`<button class="pm-action" data-restore ?disabled=${Boolean(this.busy)} @click=${() => void this.connect(p.id)}>Restore purchase</button>`}
      </div>
      ${this.deviceFlow && !this.linked
        ? html`<div class="pu-callout-connect"><p>Already own it, or on the CEO plan? Connect KinglyVault and it unlocks.</p>${this.renderConnect("compact")}</div>`
        : nothing}
    </div>`;
  }

  /** In-context upsell when a locked plugin's own page is opened. */
  renderLockedPage(p: PluginSummary): TemplateResult {
    return html`<div class="pu-upsell" data-locked-page=${p.id}>
      <div class="pu-upsell-glow" aria-hidden="true"></div>
      <p class="pm-eyebrow">Paid plugin</p>
      <h1>${p.name} is locked</h1>
      <p class="pu-upsell-sub">${p.listing?.tagline ?? p.description ?? ""}</p>
      ${this.renderAccessCallout(p)}
      <button class="pm-link" @click=${() => this.host.open(p.id)}>See what ${p.name} adds</button>
    </div>`;
  }

  /** Purchases tab. */
  renderTab(): TemplateResult {
    const s = this.summary;
    const paid = this.host.plugins().filter((p) => p.access?.requires.purchase);
    const linked = Boolean(s?.linked);
    return html`<div class="pu-wrap" data-purchases-tab>
      ${this.kv ? this.renderConnect("card") : this.renderLegacyAccount(s, linked)}
      ${this.renderPaidList(paid)}
    </div>`;
  }

  /** Older gateway / KinglyVault: the redirect-based account box. */
  private renderLegacyAccount(s: EntitlementSummary | null, linked: boolean): TemplateResult {
    return html`<section class="pu-account" data-kv-account>
        <span class="pu-account-ic">${ICON.link}</span>
        <div class="pu-account-main">
          <h2>KinglyVault account</h2>
          ${linked && s?.account
            ? html`<p>Connected as <strong data-kv-email>${s.account.email ?? s.account.id}</strong>.
                ${s.state === "grace"
                  ? html`<span class="pu-warn">Offline: using saved purchases until ${s.graceEndsAt ? new Date(s.graceEndsAt).toLocaleDateString() : "—"}.</span>`
                  : s.state === "expired"
                    ? html`<span class="pu-warn">Your saved purchases are too old. Re-check or reconnect.</span>`
                    : html`Last checked ${s.lastRefreshAt ? new Date(s.lastRefreshAt).toLocaleString() : "—"}.`}</p>
              ${s.lastError ? html`<p class="pu-warn" data-kv-error>${s.lastError}</p>` : nothing}`
            : html`<p>Paid plugins are bought on KinglyVault. Connect your account to unlock what you own on this InfiniBot. Purchases are checked with a signed token and keep working offline for 7 days.</p>`}
          ${s?.ownerGrant?.active
            ? html`<p data-owner-grant>${ICON.crown} Owner licence active on this machine: every paid plugin is unlocked${s.ownerGrant.expiresAt ? ` until ${new Date(s.ownerGrant.expiresAt).toLocaleDateString()}` : ""}.</p>`
            : nothing}
        </div>
        <div class="pu-account-actions">
          ${linked
            ? html`
                <button class="pm-action" data-kv-refresh ?disabled=${Boolean(this.busy) || !s?.canRefresh} @click=${() => void this.refreshNow()}>${ICON.refresh}${this.busy === "refresh" ? "Checking…" : "Restore purchases"}</button>
                <button class="pm-action" data-kv-unlink ?disabled=${Boolean(this.busy)} @click=${() => void this.unlink()}>Disconnect</button>`
            : html`<button class="pm-action primary" data-kv-connect ?disabled=${Boolean(this.busy)} @click=${() => void this.connect()}>${this.busy === "connect" ? "Opening…" : "Connect KinglyVault"}</button>`}
          <a class="pm-link" href=${`${this.catalog?.kinglyVault.webUrl ?? "https://kinglyvault.com"}/infinibot/purchases`} target="_blank" rel="noopener noreferrer" data-kv-manage>Manage on KinglyVault ${ICON.external}</a>
        </div>
      </section>`;
  }

  private renderPaidList(paid: PluginSummary[]): TemplateResult {
    return html`<section class="pm-section" aria-labelledby="pu-paid-h">
        <div class="pm-section-head"><h2 id="pu-paid-h" class="pm-section-title">Paid plugins <span class="pm-count">${paid.length}</span></h2></div>
        <div class="pu-list" role="list">
          ${paid.map((p) => {
            const a = p.access!;
            return html`<div class="pu-row" role="listitem" data-paid-row=${p.id}>
              <button class="pu-row-name" @click=${() => this.host.open(p.id)}>${p.name}</button>
              <span class="pu-row-sub">${p.listing?.tagline ?? ""}</span>
              <span class="pu-row-state">${a.loadable
                ? html`<span class="pu-badge b-owned" data-row-tag=${OWNED_SOURCES.has(a.source ?? "") ? "owned" : "included"}>${ICON.check}${sourceLabel(a.source)}</span>`
                : html`<span class="pu-badge b-paid" data-row-tag="buy">${ICON.lock}${a.price?.label ?? "Paid"}</span>`}</span>
              <span class="pu-row-act">${a.loadable
                ? nothing
                : html`<button class="pm-action primary" data-buy=${p.id} ?disabled=${Boolean(this.busy)} @click=${() => void this.buy(p.id)}>Buy</button>`}</span>
            </div>`;
          })}
        </div>
        <p class="pu-fine">One-time purchases. The CEO plan on KinglyVault includes every paid plugin.
          <a class="pm-link" href=${`${this.catalog?.kinglyVault.webUrl ?? "https://kinglyvault.com"}/infinibot-plugins`} target="_blank" rel="noopener noreferrer">See the CEO plan ${ICON.external}</a></p>
      </section>`;
  }

  /** Installed tab: a slim connect strip while paid plugins are locked and nothing is linked. */
  renderConnectStrip(): TemplateResult | typeof nothing {
    if (!this.kv || this.linked || this.kv.account.ownerGrant?.active) return nothing;
    const locked = this.host.plugins().some((p) => p.access?.requires.purchase && !p.access.loadable);
    if (!locked) return nothing;
    return html`<div class="pu-strip" data-kv-strip>${this.renderConnect("compact")}</div>`;
  }
}

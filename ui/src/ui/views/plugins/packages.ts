/**
 * Plugins page — plugin packages: zip import (file picker, drag & drop, URL),
 * the permission review, the Marketplace tab, and updates / rollback.
 *
 * A plain controller owned by <plugins-view>: it holds the state and renders
 * its own pieces; the view decides where they go. Mirrors
 * src/gateway/server-methods/plugins-packages.ts.
 *
 * Rules the UI keeps visible:
 *  - nothing installs before the review is accepted;
 *  - installing never turns a plugin on, and never grants a gated permission;
 *  - an update re-asks only about permissions that are new;
 *  - anything that restarts the gateway says so first.
 */

import { html, nothing, type TemplateResult } from "lit";

import { droppedFolder, filesFromDirectoryInput, zipFiles, type FolderFile } from "./zip-folder.js";
import type { GatewayBrowserClient } from "../../gateway.js";

import { errorMessage, formatBytes, monogramOf, type PluginDetail, type PluginSummary } from "./api.js";
import { isGatewayUnavailable, loadRegistryMarket, loadRegistryPlugin } from "./market-registry.js";
import { renderCardSkeletons, renderDetailHero, renderGallery, renderPluginCard, renderVerified, type CardIcon } from "./card.js";
import { generatedCover } from "./covers.js";
import { categoryLabel } from "./model.js";
import type { VaultOffer } from "./cloud-pricing.js";
import { VAULT_DOWNLOADS_ACTION, VAULT_UNLOCK_ACTION } from "../../marketplace/kinglyvault.js";

export type BrowseTab = "installed" | "marketplace" | "purchases";

export type ReviewPermission = {
  key: string;
  category: string;
  value?: string;
  label?: string;
  consent: string;
  isNew: boolean;
  gated: boolean;
  blocked: string | null;
};

export type InstallReview = {
  reviewId: string;
  plugin: {
    id: string;
    name: string;
    version: string;
    publisher: string;
    description?: string;
    license?: string;
    homepage?: string;
    minHostVersion: string;
  };
  action: "install" | "update" | "reinstall" | "downgrade" | "override-bundled" | "already-installed";
  currentVersion: string | null;
  sha256: string;
  sizeBytes: number;
  unpackedBytes: number;
  files: number;
  source: "zip" | "url" | "registry";
  firstParty: boolean;
  permissions: ReviewPermission[];
  newPermissions: string[];
  needsOverrideConfirmation: boolean;
  /** action "already-installed": the copy that's already here (newer gateways). */
  existing?: {
    origin: "bundled" | "package";
    name: string;
    version: string | null;
    enabled: boolean;
    loaded: boolean;
    access?: PluginSummary["access"];
  };
  warnings: string[];
  changelog: string | null;
  notes: { enable: string; gated: string; restart: string | null };
};

export type MarketEntry = {
  id: string;
  name: string;
  version: string;
  publisher: { id: string; name: string; verified: boolean };
  firstParty: boolean;
  description: string;
  category: string;
  tags: string[];
  pricing: {
    model: "free" | "paid";
    priceCents: number;
    currency: string;
    purchaseUrl: string | null;
    /** Hosted plans that include a paid plugin (older gateways send none). */
    includedPlans?: string[];
  };
  priceLabel: string;
  /** Paid first-party plugin this install is entitled to (plan / purchase / owner grant). */
  entitled?: boolean;
  entitledSource?: string | null;
  sizeBytes: number;
  minHostVersion: string;
  homepageUrl: string | null;
  listing: {
    cover: string | null;
    icon: string | null;
    screenshots: Array<{ src: string; caption?: string }>;
    tagline?: string;
  };
  affiliate?: { enabled: boolean };
  featured?: boolean;
  /** "external": the seller delivers the plugin (older gateways send none = hosted). */
  distribution?: "hosted" | "external";
  installed: { version: string | null; origin: string; package: boolean; updateAvailable: boolean } | null;
  compatible: boolean;
  blocked: string | null;
  /** Package checksum (hosted entries). */
  sha256?: string;
};

/** What a registry listing says the plugin asks for (registry detail; older gateways send none). */
export type MarketPermissions = {
  network?: string[];
  fs?: string[];
  secrets?: string[];
  channels?: string[];
  gated?: string[];
  exec?: boolean;
  phi?: boolean;
  credits?: boolean;
};

export type MarketVersion = { version: string; releasedAt?: string; sizeBytes?: number; minHostVersion?: string; changelog?: string };

/** `plugins.marketplace.get` / the registry's plugin page, on top of the list entry. */
export type MarketDetail = MarketEntry & { versions?: MarketVersion[]; permissions?: MarketPermissions };

export type MarketPayload = { registryUrl: string; generatedAt: string; hostVersion: string; plugins: MarketEntry[] };
type UpdatesSummary = { checkedAt: string | null; registryUrl: string | null; error: string | null; available: number };
/** `scope`: plugin id whose Versions section also shows the notice (update / rollback results). */
type Notice = { kind: "ok" | "warn" | "err"; text: string; pluginId?: string; scope?: string };
type Confirm =
  | { kind: "update"; plugin: PluginSummary; version: string }
  | { kind: "rollback"; plugin: PluginSummary; version: string };

export type PackagesHost = {
  rpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /** Re-render the view. */
  update: () => void;
  /** Reload plugins.list (and the open detail page). */
  refresh: () => Promise<void>;
  open: (pluginId: string) => void;
  plugins: () => PluginSummary[];
  runningSubagents: () => number | null;
  countSubagents: () => void;
  /** Hosted cloud: the KinglyVault CEO plan offer for a paid first-party entry (absent = none). */
  vault?: (e: MarketEntry) => VaultOffer | null;
  /** Sanitized markdown → template (the listing's long description). */
  markdown?: (md: string) => unknown;
  /** The page's screenshot lightbox. */
  openLightbox?: (pluginId: string, images: Array<{ src: string; caption?: string }>, index: number, from: HTMLElement) => void;
  /** Scroll the page content back to the top (opening / leaving a detail page). */
  scrollTop?: () => void;
  /** Paid plugin that isn't owned: KinglyVault checkout in the normal browser. */
  buy?: (pluginId: string) => void;
  /** Gateway client for the embedded <ib-kv-connect>. */
  client?: () => GatewayBrowserClient | null;
};

const ACTION_TITLE: Record<InstallReview["action"], string> = {
  install: "Install",
  update: "Update",
  reinstall: "Reinstall",
  downgrade: "Downgrade",
  "override-bundled": "Replace the built-in version of",
  "already-installed": "Already here:",
};

/** base64 of a byte range, built in slices so large chunks don't blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function filterMarket(entries: MarketEntry[], query: string): MarketEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.id.includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.publisher.name.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/** Same rule as the package format (src/plugins/packages/format.ts PACKAGE_ID_RE). */
const INSTALL_LINK_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/** Shape of a marketplace entitlement token (signed by the registry, opaque here). */
const INSTALL_TOKEN_RE = /^ib(?:in|dl)1\.[pt]\.[A-Za-z0-9_~-]{1,120}\.\d{1,12}\.[A-Za-z0-9_-]{20,100}$/;

export type InstallLink = { id: string; source: string | null; token: string | null };

/**
 * The marketplace site's "Install in InfiniBot" link:
 *   /app/plugins?install=<id>&source=marketplace[&entitlement=…]   (hosted workspace)
 *   infinibot://web/plugins?install=<id>[&entitlement=…]           (desktop app → /plugins?install=<id>)
 * `entitlement` comes from the purchase page of a paid plugin: the registry accepts it
 * (as `token`) for that plugin's download. It is kept in memory only, never saved.
 * Not `token`: on a gateway `?token=` is the control UI's own auth token.
 * Returns null when there is no `install` parameter or the id is not a plugin id.
 */
export function parseInstallLink(search: string): InstallLink | null {
  const params = new URLSearchParams(search);
  const id = (params.get("install") ?? "").trim().toLowerCase();
  if (!INSTALL_LINK_ID_RE.test(id)) return null;
  const source = (params.get("source") ?? "").trim().toLowerCase();
  const token = (params.get("entitlement") ?? "").trim();
  return {
    id,
    source: /^[a-z0-9-]{1,32}$/.test(source) ? source : null,
    token: INSTALL_TOKEN_RE.test(token) ? token : null,
  };
}

/** The seller delivers it: no download from the registry. */
export const isExternalEntry = (e: Pick<MarketEntry, "distribution">): boolean => e.distribution === "external";

/** Focused plugin first, then featured, then the registry's own order. */
export function orderMarket(entries: MarketEntry[], focusId: string | null): MarketEntry[] {
  const rank = (e: MarketEntry) => (e.id === focusId ? 0 : e.featured ? 1 : 2);
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map((x) => x.e);
}

/**
 * Primary action for a marketplace card. Exported for tests.
 *   external  sold and delivered by the publisher: open their page, import the zip
 *   buy       a paid plugin hosted here: buy on the marketplace site, then install
 *             from the purchase page (or with a token from it: `tokenInHand`)
 */
export function marketAction(
  e: MarketEntry, opts: { tokenInHand?: boolean } = {},
): { kind: "install" | "update" | "open" | "buy" | "external" | "blocked"; label: string; reason?: string } {
  if (isExternalEntry(e)) {
    if (e.installed) return { kind: "open", label: "Installed" };
    return { kind: "external", label: e.pricing.model === "paid" ? `Buy · ${e.priceLabel}` : "Get it" };
  }
  if (e.blocked) return { kind: "blocked", label: "Not available", reason: e.blocked };
  if (!e.compatible) {
    return { kind: "blocked", label: "Needs a newer InfiniBot", reason: `Needs InfiniBot ${e.minHostVersion} or newer.` };
  }
  if (e.installed?.updateAvailable) return { kind: "update", label: `Update to ${e.version}` };
  if (e.installed) return { kind: "open", label: "Installed" };
  if (e.pricing.model === "paid" && !opts.tokenInHand && !e.entitled) return { kind: "buy", label: `Buy · ${e.priceLabel}` };
  return { kind: "install", label: "Install" };
}

const TIER_LABEL = { "first-party": "First-party", verified: "Verified", community: "Community" } as const;

/** Trust tier of a listing, worded like the Installed tab's tier pill. */
export function marketTier(e: Pick<MarketEntry, "firstParty" | "publisher">): keyof typeof TIER_LABEL {
  return e.firstParty ? "first-party" : e.publisher.verified ? "verified" : "community";
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())) : []);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A listing's declared permissions in plain English, riskiest first. Exported for tests. */
export function marketPermissionLines(p: MarketPermissions | null | undefined): Array<{ key: string; text: string; risk: "high" | "medium" | "low" }> {
  if (!p || typeof p !== "object") return [];
  const out: Array<{ key: string; text: string; risk: "high" | "medium" | "low" }> = [];
  if (p.exec === true) out.push({ key: "exec", text: "Runs programs on the gateway machine", risk: "high" });
  if (p.phi === true) out.push({ key: "phi", text: "Stores protected health information", risk: "high" });
  const gated = strs(p.gated);
  if (gated.length) out.push({ key: "gated", text: `Asks for extra access that stays off until you grant it: ${andList(gated)}`, risk: "high" });
  const secrets = strs(p.secrets);
  if (secrets.length) out.push({ key: "secrets", text: `Uses ${secrets.length === 1 ? "the secret" : "the secrets"} ${andList(secrets)}`, risk: "medium" });
  const network = strs(p.network);
  if (network.length) out.push({ key: "network", text: `Connects to ${andList(network)}`, risk: "medium" });
  const channels = strs(p.channels);
  if (channels.length) out.push({ key: "channels", text: `Sends and receives messages on ${andList(channels)}`, risk: "medium" });
  if (p.credits === true) out.push({ key: "credits", text: "Spends InfiniBot credits", risk: "medium" });
  const fs = strs(p.fs);
  if (fs.length) out.push({ key: "fs", text: `Reads and writes files in ${andList(fs)}`, risk: "low" });
  return out;
}

const ICON = {
  upload: html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>`,
  refresh: html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>`,
  check: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>`,
  up: html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>`,
  shield: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/></svg>`,
  ext: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
};

export class PluginPackages {
  tab: BrowseTab = "installed";
  // import
  dragging = false;
  uploading: { name: string; sent: number; total: number } | null = null;
  inspecting = false;
  review: InstallReview | null = null;
  reviewAccepted = false;
  overrideAccepted = false;
  committing = false;
  urlOpen = false;
  urlValue = "";
  urlSha = "";
  // marketplace
  market: MarketPayload | null = null;
  marketLoading = false;
  marketError: string | null = null;
  marketQuery = "";
  /** Plugin an install deep link pointed at: its card is listed first and outlined. */
  focusId: string | null = null;
  /** Entitlement tokens from install deep links (paid plugins). Memory only. */
  tokens = new Map<string, string>();
  payment = new Map<string, string>();
  /** Marketplace detail page (null = the grid). */
  detailId: string | null = null;
  detail: MarketDetail | null = null;
  detailLoading = false;
  detailError: string | null = null;
  /** Listing images that failed to load (cover → generated cover, icon → monogram). */
  broken = new Set<string>();
  // updates
  updates: UpdatesSummary | null = null;
  checking = false;
  working = new Set<string>();
  confirm: Confirm | null = null;
  notice: Notice | null = null;

  private dragDepth = 0;
  private refreshTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly host: PackagesHost) {}

  // ── lifecycle ──────────────────────────────────────────────────────

  /** Called once the view can reach the gateway: a cheap (cached) update check. */
  connected(): void {
    void this.checkUpdates(false);
  }

  disconnected(): void {
    for (const t of this.refreshTimers) clearTimeout(t);
    this.refreshTimers = [];
  }

  setUpdatesSummary(summary: UpdatesSummary | undefined): void {
    if (summary) this.updates = summary;
  }

  private say(notice: Notice | null): void {
    this.notice = notice;
    this.host.update();
  }

  /** After a change that restarts the gateway: re-list once it is back. */
  private refreshAfterRestart(): void {
    for (const ms of [2500, 6000, 12000, 20000]) {
      this.refreshTimers.push(setTimeout(() => void this.host.refresh(), ms));
    }
  }

  // ── tabs ───────────────────────────────────────────────────────────

  setTab(tab: BrowseTab): void {
    this.tab = tab;
    this.notice = null;
    this.detailId = null;
    if (tab !== "marketplace") this.focusId = null;
    if (tab === "marketplace" && !this.market && !this.marketLoading) void this.loadMarket(false);
    this.host.update();
  }

  renderTabs(): TemplateResult {
    const available = this.updates?.available ?? 0;
    return html`<div class="pk-bar" data-packages-bar>
      <div class="pk-tabs" role="tablist" aria-label="Plugins">
        <button role="tab" id="pk-tab-installed" aria-selected=${String(this.tab === "installed")} data-tab="installed" @click=${() => this.setTab("installed")}>
          Installed${available ? html`<span class="pk-badge" data-updates-count title=${`${available} update${available === 1 ? "" : "s"} available`}>${available}</span>` : nothing}
        </button>
        <button role="tab" id="pk-tab-marketplace" aria-selected=${String(this.tab === "marketplace")} data-tab="marketplace" @click=${() => this.setTab("marketplace")}>Marketplace</button>
        <button role="tab" id="pk-tab-purchases" aria-selected=${String(this.tab === "purchases")} data-tab="purchases" @click=${() => this.setTab("purchases")}>Purchases</button>
      </div>
      <div class="pk-bar-actions">
        <button class="pp-btn pk-quiet" data-check-updates ?disabled=${this.checking} @click=${() => void this.checkUpdates(true)} title=${this.updates?.checkedAt ? `Last checked ${new Date(this.updates.checkedAt).toLocaleString()}` : "Not checked yet"}>
          ${ICON.refresh}<span>${this.checking ? "Checking…" : "Check for updates"}</span>
        </button>
        <button class="pp-btn pk-quiet" data-install-url @click=${() => { this.urlOpen = !this.urlOpen; this.host.update(); }} aria-expanded=${String(this.urlOpen)}>From URL / GitHub</button>
        <label class="pp-btn pk-quiet pk-import" data-import-folder-button title="Pick a plugin folder (the one with infinibot.plugin.json)">
          <span>From folder</span>
          <input type="file" webkitdirectory multiple class="pp-sr" data-import-folder-input @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const list = input.files ? Array.from(input.files) : [];
            input.value = "";
            if (list.length) void filesFromDirectoryInput(list).then((folder) => this.importFolder(folder));
          }} />
        </label>
        <label class="pp-btn primary pk-import" data-import-button title="A .zip plugin package. You can also drop a .zip or a plugin folder anywhere on this page.">
          ${ICON.upload}<span>Import from file</span>
          <input type="file" accept=".zip,application/zip" class="pp-sr" data-import-input @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            if (file) void this.importFile(file);
          }} />
        </label>
      </div>
    </div>
    ${this.urlOpen ? this.renderUrlForm() : nothing}
    ${this.renderProgress()}
    ${this.notice ? html`<div class="pp-note ${this.notice.kind} pk-notice" role="status" data-packages-notice>
      <span>${this.notice.text}</span>
      <span class="pk-notice-actions">
        ${this.notice.pluginId ? html`<button class="pm-link" data-notice-open @click=${() => { const id = this.notice?.pluginId; this.notice = null; if (id) this.host.open(id); }}>Open</button>` : nothing}
        <button class="pm-link" aria-label="Dismiss" @click=${() => this.say(null)}>Dismiss</button>
      </span>
    </div>` : nothing}
    ${this.updates?.error && this.tab === "installed" ? html`<div class="pp-note warn" data-updates-error>Could not check for updates: ${this.updates.error}</div>` : nothing}`;
  }

  private renderUrlForm(): TemplateResult {
    return html`<form class="pk-url" data-url-form @submit=${(e: Event) => { e.preventDefault(); void this.importUrl(); }}>
      <label class="pk-field"><span>Package URL or GitHub link (https)</span>
        <input class="pp-input" type="url" required data-url-input placeholder="https://github.com/owner/my-plugin  or  https://example.com/my-plugin-1.0.0.ibplugin.zip" .value=${this.urlValue} @input=${(e: Event) => (this.urlValue = (e.target as HTMLInputElement).value)} />
      </label>
      <label class="pk-field"><span>SHA-256 (optional, verified before install)</span>
        <input class="pp-input" type="text" spellcheck="false" placeholder="64 hex characters" .value=${this.urlSha} @input=${(e: Event) => (this.urlSha = (e.target as HTMLInputElement).value)} />
      </label>
      <button class="pp-btn primary" type="submit" ?disabled=${this.inspecting}>${this.inspecting ? "Fetching…" : "Review"}</button>
    </form>`;
  }

  private renderProgress(): TemplateResult | typeof nothing {
    if (this.uploading) {
      const pct = Math.round((this.uploading.sent / Math.max(1, this.uploading.total)) * 100);
      return html`<div class="pk-progress" role="status" data-upload-progress>
        <span>Uploading ${this.uploading.name} · ${formatBytes(this.uploading.sent)} of ${formatBytes(this.uploading.total)}</span>
        <progress max="100" .value=${pct} aria-label="Upload progress"></progress>
      </div>`;
    }
    if (this.inspecting) return html`<div class="pk-progress" role="status">Checking the package…</div>`;
    return nothing;
  }

  // ── import ─────────────────────────────────────────────────────────

  onDragEnter = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    this.dragDepth += 1;
    if (!this.dragging) {
      this.dragging = true;
      this.host.update();
    }
  };

  onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  onDragLeave = (): void => {
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0 && this.dragging) {
      this.dragging = false;
      this.host.update();
    }
  };

  onDrop = (e: DragEvent): void => {
    const dt = e.dataTransfer;
    if (!dt?.files?.length && !dt?.items?.length) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.dragging = false;
    // Read the drop now (it is only readable during the event), import after.
    const file = dt.files?.[0];
    void droppedFolder(dt)
      .then((folder) => (folder ? this.importFolder(folder) : file ? this.importFile(file) : this.host.update()))
      .catch((err) => this.say({ kind: "err", text: `Could not read what you dropped: ${errorMessage(err)}` }));
  };

  /** A plugin folder (dropped, or picked with "Import from folder"): zip it here, then the usual review. */
  async importFolder(folder: { name: string; files: FolderFile[] }): Promise<void> {
    if (!folder.files.length) {
      return this.say({ kind: "err", text: `The folder ${folder.name} is empty (or has only node_modules / .git).` });
    }
    const hasManifest = folder.files.some((f) => /(^|\/)infinibot\.plugin\.json$/.test(f.path));
    if (!hasManifest) {
      return this.say({ kind: "err", text: `${folder.name} isn't an InfiniBot plugin folder: it has no infinibot.plugin.json.` });
    }
    const bytes = zipFiles(folder.files);
    await this.importFile(new File([bytes as Uint8Array<ArrayBuffer>], `${folder.name}.zip`, { type: "application/zip" }));
  }

  async importFile(file: File): Promise<void> {
    if (this.uploading || this.inspecting) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      return this.say({ kind: "err", text: `${file.name} is not a .zip plugin package.` });
    }
    this.notice = null;
    this.uploading = { name: file.name, sent: 0, total: file.size };
    this.host.update();
    let uploadId: string | undefined;
    try {
      const begin = await this.host.rpc<{ uploadId: string; chunkBytes: number }>("plugins.install.begin", {
        fileName: file.name,
        sizeBytes: file.size,
      });
      uploadId = begin.uploadId;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let index = 0;
      for (let off = 0; off < bytes.length; off += begin.chunkBytes) {
        await this.host.rpc("plugins.install.chunk", {
          uploadId,
          index: index++,
          data: bytesToBase64(bytes.subarray(off, off + begin.chunkBytes)),
        });
        this.uploading = { name: file.name, sent: Math.min(bytes.length, off + begin.chunkBytes), total: file.size };
        this.host.update();
      }
      this.uploading = null;
      this.inspecting = true;
      this.host.update();
      this.openReview(await this.host.rpc<InstallReview>("plugins.install.inspect", { uploadId }));
    } catch (err) {
      if (uploadId) void this.host.rpc("plugins.install.cancel", { uploadId }).catch(() => undefined);
      this.say({ kind: "err", text: `Could not import ${file.name}: ${errorMessage(err)}` });
    } finally {
      this.uploading = null;
      this.inspecting = false;
      this.host.update();
    }
  }

  async importUrl(): Promise<void> {
    const url = this.urlValue.trim();
    if (!url || this.inspecting) return;
    this.notice = null;
    this.inspecting = true;
    this.host.update();
    try {
      const sha256 = this.urlSha.trim() || undefined;
      this.openReview(await this.host.rpc<InstallReview>("plugins.install.inspect", { url, sha256 }));
      this.urlOpen = false;
    } catch (err) {
      this.say({ kind: "err", text: `Could not import from that link: ${errorMessage(err)}` });
    } finally {
      this.inspecting = false;
      this.host.update();
    }
  }

  private openReview(review: InstallReview): void {
    this.review = review;
    this.enableError = null;
    // Nothing new to accept → no checkbox to tick.
    this.reviewAccepted = review.newPermissions.length === 0;
    this.overrideAccepted = !review.needsOverrideConfirmation;
    if (review.notes.restart) this.host.countSubagents();
    this.host.update();
  }

  cancelReview(): void {
    const id = this.review?.reviewId;
    this.review = null;
    if (id) void this.host.rpc("plugins.install.cancel", { reviewId: id }).catch(() => undefined);
    this.host.update();
  }

  async commitReview(): Promise<void> {
    const review = this.review;
    if (!review || this.committing || !this.reviewAccepted || !this.overrideAccepted) return;
    this.committing = true;
    this.host.update();
    try {
      const res = await this.host.rpc<{ id: string; version: string; action: string; restartRequired: boolean }>(
        "plugins.install.commit",
        {
          reviewId: review.reviewId,
          acceptedPermissions: review.permissions.map((p) => p.key),
          overrideBundled: review.needsOverrideConfirmation ? true : undefined,
        },
      );
      this.review = null;
      // A bundled plugin that was running stays on after the upgrade (restart).
      const fresh = review.action === "install" || (review.action === "override-bundled" && !res.restartRequired);
      this.notice = {
        kind: "ok",
        pluginId: res.id,
        scope: res.id,
        text: fresh
          ? `${review.plugin.name} ${res.version} is installed. It is off — open it to turn it on.`
          : `${review.plugin.name} is now ${res.version}.${res.restartRequired ? " The gateway is restarting to load it." : ""}`,
      };
      this.market = null;
      await this.host.refresh();
      if (res.restartRequired) this.refreshAfterRestart();
      if (this.tab === "marketplace") void this.loadMarket(true);
    } catch (err) {
      this.notice = { kind: "err", text: `Install failed: ${errorMessage(err)}` };
    } finally {
      this.committing = false;
      this.host.update();
    }
  }

  // ── marketplace ────────────────────────────────────────────────────

  async loadMarket(refresh: boolean): Promise<void> {
    this.marketLoading = true;
    this.marketError = null;
    this.host.update();
    try {
      this.market = await this.host.rpc<MarketPayload>("plugins.marketplace.list", { refresh });
    } catch (err) {
      // An older/serverless gateway can't answer ("unknown method") or the socket
      // is down — read the same public registry directly so the tab still works.
      if (isGatewayUnavailable(err)) {
        try {
          this.market = await loadRegistryMarket({
            fetch: (...a) => fetch(...a),
            apiBase: "/api/marketplace",
            installed: () => this.host.plugins().map((p) => ({ id: p.id, version: p.version, origin: p.origin })),
          });
          this.marketError = null;
        } catch (fallbackErr) {
          this.marketError = errorMessage(fallbackErr);
        }
      } else {
        this.marketError = errorMessage(err);
      }
    } finally {
      this.marketLoading = false;
      this.host.update();
    }
  }

  async installFromMarket(entry: MarketEntry): Promise<void> {
    if (this.working.has(entry.id)) return;
    const token = this.tokens.get(entry.id);
    this.working.add(entry.id);
    this.payment.delete(entry.id);
    this.notice = null;
    this.host.update();
    try {
      const review = await this.host.rpc<InstallReview>("plugins.install.inspect", {
        registry: token ? { id: entry.id, token } : { id: entry.id },
      });
      this.openReview(review);
    } catch (err) {
      const msg = errorMessage(err);
      if (entry.pricing.model === "paid") {
        // A rejected or expired token is no use for a retry.
        this.tokens.delete(entry.id);
        this.payment.set(entry.id, token ? `${msg} The install link from your purchase page may have expired: open the page again for a fresh one.` : msg);
      }
      else this.notice = { kind: "err", text: `Could not install ${entry.name}: ${msg}` };
    } finally {
      this.working.delete(entry.id);
      this.host.update();
    }
  }

  /**
   * An "Install in InfiniBot" deep link: open the Marketplace tab on that
   * plugin and start the normal review-first install. Nothing is installed
   * until the owner confirms the review, and a fresh install always lands
   * switched off (the gateway never enables on install).
   */
  async openInstallLink(link: InstallLink): Promise<void> {
    this.tab = "marketplace";
    this.detailId = null;
    this.focusId = link.id;
    if (link.token) this.tokens.set(link.id, link.token);
    this.marketQuery = "";
    this.notice = null;
    this.host.update();
    // A stale cached index may not have a plugin that was only just published.
    if (!this.market || !this.market.plugins.some((e) => e.id === link.id)) await this.loadMarket(Boolean(this.market));
    if (this.marketError) return; // the tab shows why the marketplace is unreachable
    const entry = this.market?.plugins.find((e) => e.id === link.id);
    if (!entry) {
      this.focusId = null;
      return this.say({ kind: "err", text: `"${link.id}" is not in the marketplace this InfiniBot uses${this.market ? ` (${this.market.registryUrl})` : ""}.` });
    }
    const act = marketAction(entry, { tokenInHand: this.tokens.has(entry.id) });
    if (act.kind === "install" || act.kind === "update") return this.installFromMarket(entry);
    if (act.kind === "open") {
      return this.say({ kind: "ok", pluginId: entry.id, text: `${entry.name} is already installed${entry.installed?.version ? ` (v${entry.installed.version})` : ""}.` });
    }
    if (act.kind === "buy") {
      return this.say({ kind: "warn", text: `${entry.name} is a paid plugin (${entry.priceLabel}). Buy it on the marketplace site, then choose Install in InfiniBot on your purchase page.` });
    }
    if (act.kind === "external") {
      return this.say({ kind: "warn", text: `${entry.name} is sold and delivered by ${entry.publisher.name}. Buy it on their page, then install the zip they send you with Import plugin.` });
    }
    this.say({ kind: "warn", text: `${entry.name} can't be installed here: ${act.reason ?? act.label}` });
  }

  /** Opens the purchase page in a new tab: our marketplace page (first-party) or the seller's (external). */
  private buy(entry: MarketEntry): void {
    const url = entry.pricing.purchaseUrl ?? (isExternalEntry(entry) ? entry.homepageUrl : null);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  // ── marketplace: shared bits ───────────────────────────────────────

  private img(src: string | null | undefined): string | undefined {
    return src && !this.broken.has(src) ? src : undefined;
  }

  private markBroken(src: string | null | undefined): void {
    if (!src || this.broken.has(src)) return;
    this.broken = new Set(this.broken).add(src);
    this.host.update();
  }

  private coverOf(e: MarketEntry): string {
    return this.img(e.listing.cover) ?? generatedCover(e.id, e.category, monogramOf(e));
  }

  private iconOf(e: MarketEntry): CardIcon {
    const src = this.img(e.listing.icon);
    return { src, monogram: monogramOf(e), onError: () => this.markBroken(e.listing.icon) };
  }

  private renderTierPill(e: MarketEntry): TemplateResult {
    const t = marketTier(e);
    return html`<span class="pm-tier t-${t}" title=${t === "first-party" ? "Made by InfiniBot" : t === "verified" ? "Verified publisher" : "Third-party publisher"}>${t === "first-party" ? html`<span class="pm-tier-glyph">${ICON.shield}</span>` : nothing}${TIER_LABEL[t]}</span>`;
  }

  private renderPrice(e: MarketEntry): TemplateResult {
    return html`<span class="pk-price ${e.pricing.model === "paid" ? "paid" : "free"}" data-price>${e.priceLabel}</span>`;
  }

  /** The Vault offer shown for an entry: only while it is something to buy. */
  private offerOf(e: MarketEntry): VaultOffer | null {
    const act = marketAction(e, { tokenInHand: this.tokens.has(e.id) });
    return act.kind === "buy" ? (this.host.vault?.(e) ?? null) : null;
  }

  /** Unlock with Vault / Buy / Install / Update / Open: the same buttons on the card and the detail page. */
  private renderMarketActions(e: MarketEntry, size: "" | "lg" = ""): TemplateResult {
    const act = marketAction(e, { tokenInHand: this.tokens.has(e.id) });
    // Labels and links only: the CEO plan is checked on KinglyVault, never here. Owned → Install / Open as usual.
    const offer = this.offerOf(e);
    const busy = this.working.has(e.id);
    return html`${offer
      ? html`<a class="pm-action primary pm-vault-unlock pk-vault-unlock ${size}" data-vault-unlock=${e.id} href=${offer.ceoUrl} target="_blank" rel="noopener noreferrer"
          aria-label=${`${VAULT_UNLOCK_ACTION} — ${e.name} is ${offer.badge.toLowerCase()}`}>${VAULT_UNLOCK_ACTION}</a>`
      : nothing}${act.kind === "open"
      ? html`<button class="pm-action ${size}" data-market-open=${e.id} @click=${() => this.host.open(e.id)}>Open</button>`
      : act.kind === "blocked"
        ? html`<button class="pm-action ${size}" disabled title=${act.reason ?? ""}>${act.label}</button>`
        : act.kind === "buy" || act.kind === "external"
          ? html`<button class="pm-action ${offer ? "pm-buy-secondary" : "primary"} ${size}" data-market-buy=${e.id} ?disabled=${!(e.pricing.purchaseUrl || (act.kind === "external" && e.homepageUrl))}
              aria-label=${`${act.label} — ${e.name}${offer ? " only" : ""}`} @click=${() => this.buy(e)}>${act.label}</button>`
          : html`<button class="pm-action primary ${size}" data-market-install=${e.id} ?disabled=${busy} @click=${() => void this.installFromMarket(e)}>${busy ? "Fetching…" : act.label}</button>`}`;
  }

  private renderInstalledState(e: MarketEntry): TemplateResult {
    return html`<span class="pk-installed" data-market-installed>${ICON.check} Installed${e.installed?.version ? ` · v${e.installed.version}` : ""}</span>`;
  }

  // ── marketplace: grid ──────────────────────────────────────────────

  private renderMarketCard(e: MarketEntry): TemplateResult {
    const act = marketAction(e, { tokenInHand: this.tokens.has(e.id) });
    const vault = this.host.vault?.(e) ?? null;
    const offer = this.offerOf(e);
    const payMsg = this.payment.get(e.id);
    return renderPluginCard({
      id: e.id,
      kind: "market",
      className: "pk-card",
      focused: this.focusId === e.id,
      name: e.name,
      cover: this.coverOf(e),
      onCoverError: () => this.markBroken(e.listing.cover),
      icon: this.iconOf(e),
      onOpen: () => this.openDetail(e.id),
      publisher: e.publisher.name,
      verified: e.publisher.verified,
      version: e.version,
      tagline: e.listing.tagline || e.description,
      coverBadges: html`${this.renderTierPill(e)}${act.kind === "update" ? html`<span class="pk-update-chip" data-update-badge=${e.id}>${ICON.up}<span>Update ${e.version}</span></span>` : this.renderPrice(e)}`,
      tags: html`${vault ? html`<span class="pm-vault-badge" data-vault-badge>${vault.badge}</span>` : nothing}${e.featured ? html`<span class="pm-chip cat" data-featured>Featured</span>` : nothing}<span class="pm-chip cat">${categoryLabel(e.category)}</span>${e.tags.slice(0, 2).map((t) => html`<span class="pm-chip">${t}</span>`)}`,
      extra: html`${offer
        ? html`<a class="pm-link pm-vault-dl pk-card-dl" data-vault-downloads href=${offer.downloadsUrl} target="_blank" rel="noopener noreferrer">${VAULT_DOWNLOADS_ACTION}</a>`
        : nothing}${payMsg ? html`<p class="pk-inline-err" role="alert" data-payment-error>${payMsg}</p>` : nothing}${act.kind === "blocked" ? html`<p class="pp-help" data-market-blocked>${act.reason}</p>` : nothing}`,
      footStart: e.installed
        ? this.renderInstalledState(e)
        : e.homepageUrl
          ? html`<a class="pm-link pk-site" href=${e.homepageUrl} target="_blank" rel="noopener noreferrer">Website</a>`
          : html`<span></span>`,
      footActions: this.renderMarketActions(e),
    });
  }

  renderMarketplace(): TemplateResult {
    const m = this.market;
    const list = m ? orderMarket(filterMarket(m.plugins, this.marketQuery), this.focusId) : [];
    return html`<section class="pk-market" role="tabpanel" aria-labelledby="pk-tab-marketplace" data-marketplace>
      <div class="pk-market-head">
        <label class="pm-search">
          <input type="search" placeholder="Search the marketplace…" aria-label="Search the marketplace" .value=${this.marketQuery} @input=${(e: Event) => { this.marketQuery = (e.target as HTMLInputElement).value; this.host.update(); }} />
        </label>
        <span class="pk-market-meta">${m ? html`${m.plugins.length} plugin${m.plugins.length === 1 ? "" : "s"} · <span class="pp-code" title="Registry">${m.registryUrl}</span>` : nothing}</span>
        <button class="pp-btn pk-quiet" data-market-refresh ?disabled=${this.marketLoading} @click=${() => void this.loadMarket(true)}>${ICON.refresh}<span>Refresh</span></button>
      </div>
      ${this.marketError
        ? html`<div class="pp-note err" role="alert" data-market-error>
            <b>The marketplace could not be reached.</b> ${this.marketError}
            <div class="pp-actions"><button class="pp-btn" @click=${() => void this.loadMarket(true)}>Try again</button></div>
          </div>`
        : this.marketLoading && !m
          ? renderCardSkeletons(6, "Loading the marketplace")
          : !m
            ? nothing
            : !list.length
              ? html`<div class="pk-empty" data-market-empty>${m.plugins.length ? "No plugin matches your search." : "The marketplace has no plugins yet."}</div>`
              : html`<div class="pm-grid" aria-label="Marketplace plugins">${list.map((e) => this.renderMarketCard(e))}</div>`}
    </section>`;
  }

  // ── marketplace: detail page ───────────────────────────────────────

  /** The list entry merged with its registry detail (detail fields win, install state stays the list's). */
  marketEntry(id: string | null = this.detailId): MarketDetail | null {
    if (!id) return null;
    const base = this.market?.plugins.find((e) => e.id === id) ?? null;
    const d = this.detail && this.detail.id === id ? this.detail : null;
    if (!base) return d;
    if (!d) return base;
    return { ...base, ...d, priceLabel: d.priceLabel || base.priceLabel, installed: base.installed, compatible: base.compatible, blocked: base.blocked, featured: base.featured };
  }

  openDetail(id: string): void {
    this.detailId = id;
    this.detailError = null;
    this.host.update();
    this.host.scrollTop?.();
    if (this.detail?.id !== id) void this.loadDetail(id);
  }

  closeDetail(): void {
    if (!this.detailId) return;
    this.detailId = null;
    this.host.update();
    this.host.scrollTop?.();
  }

  async loadDetail(id: string): Promise<void> {
    this.detailLoading = true;
    this.host.update();
    try {
      let res: { plugin: MarketDetail };
      try {
        res = await this.host.rpc<{ plugin: MarketDetail }>("plugins.marketplace.get", { id });
      } catch (err) {
        if (!isGatewayUnavailable(err)) throw err;
        res = (await loadRegistryPlugin(
          { fetch: (...a) => fetch(...a), apiBase: "/api/marketplace", installed: () => this.host.plugins().map((p) => ({ id: p.id, version: p.version, origin: p.origin })) },
          id,
        )) as { plugin: MarketDetail };
      }
      if (this.detailId === id) {
        this.detail = res.plugin;
        this.detailError = null;
      }
    } catch (err) {
      if (this.detailId === id) this.detailError = errorMessage(err);
    } finally {
      this.detailLoading = false;
      this.host.update();
    }
  }

  /** What the action panel says next to the buttons. */
  private renderActionCopy(e: MarketEntry): TemplateResult {
    const act = marketAction(e, { tokenInHand: this.tokens.has(e.id) });
    const offer = this.offerOf(e);
    const included = e.pricing.includedPlans ?? [];
    const paid = e.pricing.model === "paid";
    switch (act.kind) {
      case "open":
        return html`<b>${e.name} is installed${e.installed?.version ? ` (v${e.installed.version})` : ""}.</b> <span class="pp-muted">Open it to turn it on, set it up or change what it may do.</span>`;
      case "update":
        return html`<b>Version ${e.version} is available.</b> <span class="pp-muted">You have ${e.installed?.version ?? "an older version"}. Your settings, data and permissions are kept, and you can roll back.</span>`;
      case "blocked":
        return html`<b>${act.label}.</b> <span class="pp-muted">${act.reason ?? ""}</span>`;
      case "external":
        return html`<b>${paid ? `${e.name} is a paid plugin (${e.priceLabel}).` : `${e.name} is delivered by ${e.publisher.name}.`}</b> <span class="pp-muted" data-market-external>Sold and delivered by ${e.publisher.name}. After buying, install the zip they send you with <b>Import plugin</b>.</span>`;
      case "buy":
        return html`<b>${e.name} is a paid plugin (${e.priceLabel}).</b> <span class="pp-muted">${offer
          ? html`<span data-vault-help>${offer.badge}: unlock it with every other InfiniBot plugin on KinglyVault, or buy just this one.</span>`
          : html`<span data-market-paid>Bought on the InfiniBot marketplace site. After paying, choose <b>Install in InfiniBot</b> on your purchase page, or import the zip you download there.</span>`}${included.length && !offer
          ? html` <span data-included-plans>Included in the ${included.join(", ")} plan${included.length === 1 ? "" : "s"} on InfiniBot Cloud: sign in on its marketplace page to get your install link.</span>`
          : nothing}</span>`;
      default:
        return html`<b>${paid ? `${e.name} (${e.priceLabel})` : `${e.name} is free.`}</b> <span class="pp-muted">You review what it asks for before anything installs, and it lands switched off.</span>`;
    }
  }

  private renderMarketFacts(e: MarketDetail): TemplateResult {
    const released = e.versions?.find((v) => v.version === e.version)?.releasedAt ?? e.versions?.[0]?.releasedAt;
    const date = released && !Number.isNaN(Date.parse(released)) ? new Date(released).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
    const sha = e.sha256 ? `${e.sha256.slice(0, 12)}…` : null;
    return html`<dl class="pm-facts" data-market-facts>
      <div><dt>Version</dt><dd data-market-version>v${e.version}</dd></div>
      <div><dt>Publisher</dt><dd>${e.publisher.name}${e.publisher.verified ? renderVerified() : nothing}</dd></div>
      <div><dt>Trust</dt><dd>${TIER_LABEL[marketTier(e)]}</dd></div>
      <div><dt>Price</dt><dd>${e.priceLabel}</dd></div>
      <div><dt>Category</dt><dd>${categoryLabel(e.category)}</dd></div>
      ${e.sizeBytes ? html`<div><dt>Size</dt><dd>${formatBytes(e.sizeBytes)}</dd></div>` : nothing}
      ${sha ? html`<div><dt>SHA-256</dt><dd><span class="pp-code" title=${e.sha256 ?? ""} data-market-sha>${sha}</span></dd></div>` : nothing}
      <div><dt>Needs InfiniBot</dt><dd>${e.minHostVersion} or newer</dd></div>
      ${date ? html`<div><dt>Released</dt><dd>${date}</dd></div>` : nothing}
      ${e.installed ? html`<div><dt>Installed</dt><dd>${e.installed.version ? `v${e.installed.version}` : "Yes"}</dd></div>` : nothing}
      ${e.homepageUrl ? html`<div class="pm-facts-links"><dt>Links</dt><dd><a class="pm-ext" href=${e.homepageUrl} target="_blank" rel="noopener noreferrer">Website<span class="pm-ext-ic">${ICON.ext}</span></a></dd></div>` : nothing}
    </dl>`;
  }

  private renderMarketSection(id: string, title: string, body: unknown): TemplateResult {
    return html`<section class="pm-dsec" id=${`msec-${id}`} data-market-section=${id} aria-labelledby=${`msech-${id}`}>
      <div class="pm-dsec-head"><h2 class="pm-dsec-title" id=${`msech-${id}`}>${title}</h2></div>
      ${body}
    </section>`;
  }

  renderMarketDetail(): TemplateResult {
    const e = this.marketEntry();
    const id = this.detailId ?? "";
    if (!e) {
      return html`<div class="pm-detail-missing" data-market-detail-page=${id}>
        <button class="pm-back" data-back @click=${() => this.closeDetail()}>Marketplace</button>
        <div class="pm-empty"><h3>${this.detailLoading || this.marketLoading ? "Loading…" : this.detailError ?? `“${id}” is not in the marketplace`}</h3></div>
      </div>`;
    }
    const vault = this.host.vault?.(e) ?? null;
    const offer = this.offerOf(e);
    const payMsg = this.payment.get(e.id);
    const loaded = Boolean(this.detail && this.detail.id === e.id);
    const shots = e.listing.screenshots.filter((s) => !this.broken.has(s.src));
    const perms = marketPermissionLines(e.permissions);
    const md = e.description;
    return html`<article class="pm-detail pk-mdetail" data-market-detail-page=${e.id} aria-label=${`${e.name} in the marketplace`}>
      ${renderDetailHero({
        name: e.name,
        cover: this.coverOf(e),
        onCoverError: () => this.markBroken(e.listing.cover),
        icon: this.iconOf(e),
        kicker: categoryLabel(e.category),
        tagline: e.listing.tagline || "",
        meta: html`${this.renderTierPill(e)}${vault ? html`<span class="pm-vault-badge" data-vault-badge>${vault.badge}</span>` : nothing}<span>${e.publisher.name}${e.publisher.verified ? renderVerified() : nothing}</span><span>v${e.version}</span>${e.installed ? this.renderInstalledState(e) : nothing}`,
        actions: this.renderPrice(e),
        backLabel: "Marketplace",
        onBack: () => this.closeDetail(),
      })}
      <div class="pm-enable-cta pk-actions-panel" data-market-actions>
        <div>${this.renderActionCopy(e)}${offer ? html` <a class="pm-link pm-vault-dl" data-vault-downloads href=${offer.downloadsUrl} target="_blank" rel="noopener noreferrer">${VAULT_DOWNLOADS_ACTION}</a>` : nothing}</div>
        <span class="pm-enable-actions">${this.renderMarketActions(e, "lg")}</span>
      </div>
      ${payMsg ? html`<div class="pp-note err pm-dnote" role="alert" data-payment-error>${payMsg}</div>` : nothing}
      ${this.detailError ? html`<div class="pp-note warn pm-dnote" role="status">Could not load the full listing: ${this.detailError}</div>` : nothing}
      <div class="pm-dgrid">
        <div class="pm-dmain">
          ${this.renderMarketSection("overview", "Overview", html`
            ${renderGallery({
              name: e.name,
              shots,
              src: (s) => this.img(s.src),
              onError: (s) => this.markBroken(s.src),
              onOpen: (i, from) => (this.host.openLightbox ? this.host.openLightbox(e.id, shots, i, from) : window.open(shots[i]?.src, "_blank", "noopener,noreferrer")),
            })}
            <div class="pm-overview">
              <div class="pm-prose" data-description>
                ${md ? (this.host.markdown ? this.host.markdown(md) : html`<p>${md}</p>`) : html`<p class="pp-muted">No description.</p>`}
              </div>
              ${e.tags.length ? html`<div class="pm-tags lg">${e.tags.map((t) => html`<span class="pm-chip">${t}</span>`)}</div>` : nothing}
            </div>`)}
          ${this.renderMarketSection("permissions", "Permissions", !loaded && this.detailLoading
            ? html`<div class="pm-dloading" aria-busy="true"><div class="sk w60"></div><div class="sk w90"></div></div>`
            : perms.length
              ? html`<ul class="pk-perms" data-market-permissions>${perms.map((p) => html`<li class="pk-perm ${p.risk === "high" ? "gated" : ""}" data-market-permission=${p.key}><span class="pk-perm-text">${p.text}</span><span class="pk-perm-meta"><span class="pk-flag ${p.risk === "high" ? "gated" : "new"}">${p.risk === "high" ? "High impact" : p.risk === "medium" ? "Medium" : "Low"}</span></span></li>`)}</ul>
                  <p class="pp-help">You review each one again before it installs. Gated access stays off until you grant it.</p>`
              : html`<p class="pp-p pp-muted" data-market-permissions-none>${e.permissions ? "It asks for no special permissions." : "The listing doesn't summarise its permissions. You see the full list in the review before anything installs."}</p>`)}
          ${e.versions?.length
            ? this.renderMarketSection("versions", "Versions", html`<div class="pk-changelog" data-market-versions>${e.versions.slice(0, 6).map(
                (v) => html`<div class="pk-change"><div class="pk-change-head"><b>${v.version}</b>${v.releasedAt && !Number.isNaN(Date.parse(v.releasedAt)) ? html`<span class="pp-muted">${new Date(v.releasedAt).toLocaleDateString()}</span>` : nothing}${v.sizeBytes ? html`<span class="pp-muted">${formatBytes(v.sizeBytes)}</span>` : nothing}</div><p>${v.changelog || "No release notes."}</p></div>`,
              )}</div>`)
            : nothing}
        </div>
        <aside class="pm-dside" aria-label=${`About ${e.name}`}>
          <h2 class="pm-side-h">About</h2>
          ${this.renderMarketFacts(e)}
        </aside>
      </div>
    </article>`;
  }

  // ── updates ────────────────────────────────────────────────────────

  async checkUpdates(force: boolean): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.host.update();
    try {
      await this.host.rpc("plugins.updates.check", { force });
      await this.host.refresh();
      if (force) {
        const n = this.updates?.available ?? 0;
        this.notice = this.updates?.error
          ? null
          : { kind: "ok", text: n ? `${n} update${n === 1 ? "" : "s"} available.` : "Everything is up to date." };
      }
    } catch (err) {
      if (force) this.notice = { kind: "err", text: `Update check failed: ${errorMessage(err)}` };
    } finally {
      this.checking = false;
      this.host.update();
    }
  }

  renderUpdateBadge(p: PluginSummary): TemplateResult | typeof nothing {
    const v = (p as PluginSummary & { updateAvailable?: string | null }).updateAvailable;
    if (!v) return nothing;
    return html`<span class="pk-update-chip" data-update-badge=${p.id} title=${`Version ${v} is available`}>${ICON.up}<span>Update ${v}</span></span>`;
  }

  askUpdate(p: PluginSummary, version: string): void {
    // A running plugin restarts the gateway when its files change: confirm first.
    if (p.status === "loaded") {
      this.confirm = { kind: "update", plugin: p, version };
      this.host.countSubagents();
      this.host.update();
      return;
    }
    void this.runUpdate(p, version);
  }

  askRollback(p: PluginSummary, version: string): void {
    this.confirm = { kind: "rollback", plugin: p, version };
    if (p.status === "loaded") this.host.countSubagents();
    this.host.update();
  }

  async runUpdate(p: PluginSummary, version: string): Promise<void> {
    if (this.working.has(p.id)) return;
    this.working.add(p.id);
    this.notice = null;
    this.host.update();
    try {
      const res = await this.host.rpc<{ status: string; version?: string; restartRequired?: boolean; review?: InstallReview }>(
        "plugins.update",
        { id: p.id, version },
      );
      if (res.status === "needs-review" && res.review) {
        this.openReview(res.review);
      } else if (res.status === "updated") {
        this.notice = {
          kind: "ok",
          scope: p.id,
          text: `${p.name} updated to ${res.version}.${res.restartRequired ? " The gateway is restarting to load it." : ""} You can roll back from Versions.`,
        };
        await this.host.refresh();
        if (res.restartRequired) this.refreshAfterRestart();
      } else {
        this.notice = { kind: "ok", scope: p.id, text: `${p.name} is already up to date.` };
        await this.host.refresh();
      }
    } catch (err) {
      this.notice = { kind: "err", scope: p.id, text: `Could not update ${p.name}: ${errorMessage(err)}` };
    } finally {
      this.working.delete(p.id);
      this.host.update();
    }
  }

  async runRollback(p: PluginSummary): Promise<void> {
    if (this.working.has(p.id)) return;
    this.working.add(p.id);
    this.notice = null;
    this.host.update();
    try {
      const res = await this.host.rpc<{ version: string; from: string; restored: string; restartRequired: boolean }>(
        "plugins.rollback",
        { id: p.id },
      );
      this.notice = {
        kind: "ok",
        scope: p.id,
        text:
          res.restored === "bundled"
            ? `${p.name} is back on the built-in version ${res.version}.`
            : `${p.name} rolled back from ${res.from} to ${res.version}.${res.restartRequired ? " The gateway is restarting to load it." : ""}`,
      };
      await this.host.refresh();
      if (res.restartRequired) this.refreshAfterRestart();
    } catch (err) {
      this.notice = { kind: "err", scope: p.id, text: `Could not roll back ${p.name}: ${errorMessage(err)}` };
    } finally {
      this.working.delete(p.id);
      this.host.update();
    }
  }

  async setAuto(p: PluginSummary, auto: boolean): Promise<void> {
    try {
      await this.host.rpc("plugins.updates.setAuto", { id: p.id, auto });
      await this.host.refresh();
    } catch (err) {
      this.say({ kind: "err", scope: p.id, text: `Could not change auto-update: ${errorMessage(err)}` });
    }
  }

  /** The Versions section of a plugin's detail page. */
  renderVersions(d: PluginDetail): TemplateResult {
    const v = d.versions;
    const p = d.plugin;
    const busy = this.working.has(p.id);
    const short = v.sha256 ? `${v.sha256.slice(0, 12)}…` : null;
    return html`
      ${this.notice?.scope === p.id && !this.review ? html`<div class="pp-note ${this.notice.kind}" role="status" data-versions-notice>${this.notice.text}</div>` : nothing}
      ${v.pendingRestart ? html`<div class="pp-note warn" data-pending-restart>Version ${v.pendingRestart} was installed automatically and takes effect at the next gateway restart.</div>` : nothing}
      <dl class="pp-kv">
        <dt>Installed</dt><dd data-version-current>${v.current ?? "—"}</dd>
        <dt>Source</dt><dd>${v.source}${v.overridesBundled ? " (replaces the built-in version)" : ""}${v.spec ? html` · <span class="pp-code">${v.spec}</span>` : nothing}</dd>
        ${v.installedAt ? html`<dt>Installed at</dt><dd>${new Date(v.installedAt).toLocaleString()}</dd>` : nothing}
        ${short ? html`<dt>Package SHA-256</dt><dd><span class="pp-code" title=${v.sha256 ?? ""}>${short}</span></dd>` : nothing}
        ${v.minHostVersion ? html`<dt>Needs InfiniBot</dt><dd>${v.minHostVersion} or newer</dd>` : nothing}
        <dt>Updates</dt><dd data-update-status>${v.updateCheck}${v.checkedAt ? html` <span class="pp-muted">· checked ${new Date(v.checkedAt).toLocaleString()}</span>` : nothing}</dd>
        ${v.blocked ? html`<dt>Held back</dt><dd>${v.blocked}</dd>` : nothing}
      </dl>
      ${v.updateAvailable && v.changelog?.length
        ? html`<div class="pk-changelog" data-changelog>
            <h4>What's new</h4>
            ${v.changelog.map(
              (c) => html`<div class="pk-change"><div class="pk-change-head"><b>${c.version}</b>${c.releasedAt ? html`<span class="pp-muted">${new Date(c.releasedAt).toLocaleDateString()}</span>` : nothing}</div><p>${c.notes || "No release notes."}</p></div>`,
            )}
          </div>`
        : nothing}
      ${v.managed
        ? html`<label class="pk-auto"><input type="checkbox" data-auto-update .checked=${Boolean(v.autoUpdate)} @change=${(e: Event) => void this.setAuto(p, (e.target as HTMLInputElement).checked)} />
            <span><b>Update automatically</b><br /><span class="pp-muted">Off by default. A version that asks for new permissions is never installed without you.</span></span></label>`
        : nothing}
      <div class="pp-actions">
        <button class="pp-btn primary" data-update-now ?disabled=${!v.updateAvailable || busy} @click=${() => v.updateAvailable && this.askUpdate(p, v.updateAvailable)}>${busy ? "Working…" : v.updateAvailable ? `Update to ${v.updateAvailable}` : "Update"}</button>
        <button class="pp-btn" data-rollback ?disabled=${!v.rollbackAvailable || busy} title=${v.rollbackAvailable ? "" : "No previous version is kept for this plugin"} @click=${() => v.previousVersion && this.askRollback(p, v.previousVersion)}>${v.rollbackAvailable && v.previousVersion ? `Roll back to ${v.previousVersion}` : "Roll back"}</button>
        ${v.managed ? html`<button class="pp-btn" data-check-one ?disabled=${this.checking} @click=${() => void this.checkUpdates(true)}>${this.checking ? "Checking…" : "Check now"}</button>` : nothing}
      </div>
    `;
  }

  // ── overlays ───────────────────────────────────────────────────────

  private subagentNote(): TemplateResult {
    const n = this.host.runningSubagents();
    if (n === null) return html`<p class="pp-help">Checking for running sub-agents…</p>`;
    if (n === 0) return html`<p class="pp-help">No sub-agents are running.</p>`;
    return html`<div class="pp-note warn"><b>${n} sub-agent${n === 1 ? " is" : "s are"} running.</b> The restart stops ${n === 1 ? "it" : "them"}.</div>`;
  }

  private renderReview(): TemplateResult | typeof nothing {
    const r = this.review;
    if (!r) return nothing;
    if (r.action === "already-installed") return this.renderAlreadyHere(r);
    const title = `${ACTION_TITLE[r.action]} ${r.plugin.name}`;
    const isUpdate = r.action !== "install";
    const ready = this.reviewAccepted && this.overrideAccepted && !this.committing;
    const shown = isUpdate && r.newPermissions.length ? r.permissions.filter((p) => p.isNew) : r.permissions;
    const already = isUpdate ? r.permissions.length - r.newPermissions.length : 0;
    return html`<div class="pp-modal-bg" @click=${(e: Event) => e.target === e.currentTarget && this.cancelReview()}>
      <div class="pp-modal pk-review" role="dialog" aria-modal="true" aria-labelledby="pk-review-title" data-install-review tabindex="-1">
        <h3 id="pk-review-title">${title}</h3>
        <p class="pk-review-sub">
          ${r.currentVersion ? html`<span data-review-versions>${r.currentVersion} → <b>${r.plugin.version}</b></span>` : html`<span data-review-versions>Version <b>${r.plugin.version}</b></span>`}
          · by ${r.plugin.publisher}${r.firstParty ? " (first-party)" : ""}
          · ${formatBytes(r.sizeBytes)}, ${r.files} files
        </p>
        ${r.plugin.description ? html`<p class="pp-p">${r.plugin.description}</p>` : nothing}
        ${r.warnings.map((w) => html`<div class="pp-note warn" data-review-warning>${w}</div>`)}

        <h4 class="pk-h4">${isUpdate && r.newPermissions.length ? "New permissions it asks for" : "What it asks permission for"}</h4>
        ${shown.length === 0
          ? html`<p class="pp-p" data-review-none>${isUpdate && r.permissions.length ? "Nothing new — it keeps the permissions you already reviewed." : "Nothing. This plugin requests no permissions."}</p>`
          : html`<ul class="pk-perms" data-review-permissions>
              ${shown.map(
                (p) => html`<li class="pk-perm ${p.gated ? "gated" : ""}" data-review-permission=${p.key}>
                  <span class="pk-perm-text">${p.consent}</span>
                  <span class="pk-perm-meta">
                    <span class="pp-code">${p.key}</span>
                    ${p.isNew && isUpdate ? html`<span class="pk-flag new">New</span>` : nothing}
                    ${p.gated ? html`<span class="pk-flag gated">Stays off until you grant it</span>` : nothing}
                    ${p.blocked ? html`<span class="pk-flag gated" title=${p.blocked}>Not available here</span>` : nothing}
                  </span>
                </li>`,
              )}
            </ul>`}
        ${already > 0 && r.newPermissions.length ? html`<p class="pp-help">${already} permission${already === 1 ? "" : "s"} you already reviewed stay as you set them.</p>` : nothing}

        ${r.changelog ? html`<details class="pk-details"><summary>Changelog</summary><pre class="pk-pre">${r.changelog}</pre></details>` : nothing}
        <details class="pk-details"><summary>Package details</summary>
          <dl class="pp-kv">
            <dt>Plugin id</dt><dd class="pp-code">${r.plugin.id}</dd>
            <dt>SHA-256</dt><dd class="pp-code" data-review-sha>${r.sha256}</dd>
            <dt>Unpacked size</dt><dd>${formatBytes(r.unpackedBytes)}</dd>
            <dt>Source</dt><dd>${r.source === "registry" ? "Marketplace (checksum verified)" : r.source === "url" ? "URL" : "Uploaded file"}</dd>
            <dt>Needs InfiniBot</dt><dd>${r.plugin.minHostVersion} or newer</dd>
            ${r.plugin.license ? html`<dt>License</dt><dd>${r.plugin.license}</dd>` : nothing}
          </dl>
        </details>

        ${r.newPermissions.length
          ? html`<label class="pk-accept"><input type="checkbox" data-review-accept .checked=${this.reviewAccepted} @change=${(e: Event) => { this.reviewAccepted = (e.target as HTMLInputElement).checked; this.host.update(); }} />
              <span>I reviewed ${r.newPermissions.length === 1 ? "this permission" : `these ${r.newPermissions.length} permissions`} and want to ${isUpdate ? "update" : "install"} ${r.plugin.name}.</span></label>`
          : nothing}
        ${r.needsOverrideConfirmation
          ? html`<label class="pk-accept"><input type="checkbox" data-review-override .checked=${this.overrideAccepted} @change=${(e: Event) => { this.overrideAccepted = (e.target as HTMLInputElement).checked; this.host.update(); }} />
              <span>Replace the ${r.plugin.name} that ships with InfiniBot with this package. I trust where it came from.</span></label>`
          : nothing}

        <p class="pp-help" data-review-note>${isUpdate ? "Your settings, data, on/off switch and granted permissions are kept. The current version is kept so you can roll back." : r.notes.enable} ${r.permissions.some((p) => p.gated) ? r.notes.gated : ""}</p>
        ${r.notes.restart ? html`<div class="pp-note warn">${r.notes.restart}</div>${this.subagentNote()}` : nothing}

        <div class="pp-actions" style="justify-content:flex-end">
          <button class="pp-btn" data-review-cancel @click=${() => this.cancelReview()}>Cancel</button>
          <button class="pp-btn primary" data-review-confirm ?disabled=${!ready} @click=${() => void this.commitReview()}>
            ${this.committing ? "Installing…" : isUpdate ? `Update to ${r.plugin.version}` : "Install (stays off)"}
          </button>
        </div>
      </div>
    </div>`;
  }

  /**
   * The imported plugin is already here (ships with InfiniBot, or the same
   * package is installed): no error, offer to turn it on. A paid plugin
   * that isn't owned offers Buy / Connect KinglyVault instead.
   */
  private renderAlreadyHere(r: InstallReview): TemplateResult {
    const e = r.existing;
    const name = e?.name ?? r.plugin.name;
    const bundled = (e?.origin ?? "bundled") === "bundled";
    const access = e?.access;
    const locked = Boolean(access && !access.loadable);
    const on = Boolean(e?.enabled && e.loaded);
    const version = e?.version ?? r.currentVersion;
    const older = Boolean(version && version !== r.plugin.version);
    const title = `${name} is already ${bundled ? "included" : "installed"}`;
    return html`<div class="pp-modal-bg" @click=${(ev: Event) => ev.target === ev.currentTarget && this.cancelReview()}>
      <div class="pp-modal pk-review" role="dialog" aria-modal="true" aria-labelledby="pk-review-title" data-install-review data-review-action="already-installed" tabindex="-1">
        <h3 id="pk-review-title" data-review-title>${title}</h3>
        <p class="pp-p" data-review-already>
          ${bundled
            ? html`InfiniBot already comes with ${name}${version ? html` <b>${version}</b>` : nothing}, so there is nothing to install${older ? html` (the file you picked is ${r.plugin.version}, an older version)` : nothing}.`
            : html`${name} ${version ? html`<b>${version}</b> ` : nothing}is already installed from this same file, so there is nothing to install.`}
        </p>
        ${on
          ? html`<div class="pp-note ok" data-review-on>${name} is on.</div>`
          : locked
            ? html`<div class="pp-note warn" data-review-locked>
                  ${name} is a paid plugin${access?.price ? ` (${access.price.label} one-time)` : ""}. Buy it on KinglyVault, or connect your KinglyVault account if you already own it or your plan includes it.
                </div>
                ${this.host.client ? html`<ib-kv-connect .client=${this.host.client()} variant="compact"
                  @kv-changed=${() => void this.afterKvChange(r)}></ib-kv-connect>` : nothing}`
            : html`<p class="pp-help">Turning it on restarts InfiniBot for a few seconds.</p>`}
        ${this.enableError ? html`<div class="pp-note err" role="alert" data-review-error>${this.enableError}</div>` : nothing}
        <div class="pp-actions" style="justify-content:flex-end">
          <button class="pp-btn" data-review-cancel @click=${() => this.cancelReview()}>${on ? "Close" : "Cancel"}</button>
          ${on
            ? html`<button class="pp-btn primary" data-review-open @click=${() => { const id = r.plugin.id; this.cancelReview(); this.host.open(id); }}>Open ${name}</button>`
            : locked
              ? html`<button class="pp-btn primary" data-review-buy @click=${() => this.host.buy?.(r.plugin.id)}>${access?.price ? `Buy · ${access.price.label}` : "Buy"}</button>`
              : html`<button class="pp-btn primary" data-review-enable ?disabled=${this.committing} @click=${() => void this.enableExisting(r)}>
                  ${this.committing ? "Turning on…" : `Enable ${name}`}
                </button>`}
        </div>
      </div>
    </div>`;
  }

  enableError: string | null = null;

  /** "Enable it" from the already-here dialog: the same switch as the card. */
  async enableExisting(r: InstallReview): Promise<void> {
    if (this.committing) return;
    this.committing = true;
    this.enableError = null;
    this.host.update();
    try {
      await this.host.rpc("plugins.setEnabled", { id: r.plugin.id, enabled: true });
      this.review = null;
      void this.host.rpc("plugins.install.cancel", { reviewId: r.reviewId }).catch(() => undefined);
      this.notice = {
        kind: "ok",
        pluginId: r.plugin.id,
        scope: r.plugin.id,
        text: `${r.existing?.name ?? r.plugin.name} is on. InfiniBot is restarting for a few seconds to load it.`,
      };
      await this.host.refresh();
      this.refreshAfterRestart();
    } catch (err) {
      this.enableError = `Couldn't turn it on: ${errorMessage(err)}`;
    } finally {
      this.committing = false;
      this.host.update();
    }
  }

  /** Connected / synced from inside the dialog: re-read whether it is unlocked now. */
  private async afterKvChange(r: InstallReview): Promise<void> {
    await this.host.refresh();
    const p = this.host.plugins().find((x) => x.id === r.plugin.id);
    if (this.review?.reviewId === r.reviewId && this.review.existing && p?.access) {
      this.review = { ...this.review, existing: { ...this.review.existing, access: p.access } };
    }
    this.host.update();
  }

  private renderConfirm(): TemplateResult | typeof nothing {
    const c = this.confirm;
    if (!c) return nothing;
    const close = () => {
      this.confirm = null;
      this.host.update();
    };
    const running = c.plugin.status === "loaded";
    const go = () => {
      close();
      if (c.kind === "update") void this.runUpdate(c.plugin, c.version);
      else void this.runRollback(c.plugin);
    };
    const title = c.kind === "update" ? `Update ${c.plugin.name} to ${c.version}?` : `Roll ${c.plugin.name} back to ${c.version}?`;
    return html`<div class="pp-modal-bg" @click=${(e: Event) => e.target === e.currentTarget && close()}>
      <div class="pp-modal" role="dialog" aria-modal="true" aria-label=${title} data-packages-confirm=${c.kind} tabindex="-1">
        <h3>${title}</h3>
        <p class="pp-p">${c.kind === "update"
          ? "Your settings, data and permissions are kept, and the current version is kept so you can roll back."
          : `This puts version ${c.version} back. The version you are leaving is kept, so you can return to it.`}</p>
        ${running ? html`<p class="pp-p">${c.plugin.name} is running, so the gateway restarts to load the other version. Open connections reconnect automatically.</p>${this.subagentNote()}` : html`<p class="pp-help">${c.plugin.name} is off, so nothing restarts.</p>`}
        <div class="pp-actions" style="justify-content:flex-end">
          <button class="pp-btn" @click=${close}>Cancel</button>
          <button class="pp-btn primary" data-packages-confirm-go @click=${go}>${c.kind === "update" ? (running ? "Update & restart" : "Update") : running ? "Roll back & restart" : "Roll back"}</button>
        </div>
      </div>
    </div>`;
  }

  renderOverlays(): TemplateResult {
    return html`
      ${this.dragging ? html`<div class="pk-drop" data-drop-overlay aria-hidden="true"><div class="pk-drop-box">${ICON.upload}<b>Drop the plugin to import it</b><span>A .zip or a plugin folder · you review its permissions before anything installs</span></div></div>` : nothing}
      ${this.renderReview()}
      ${this.renderConfirm()}
    `;
  }

  /** Escape closes the top-most package overlay. Returns true when it handled the key. */
  handleEscape(): boolean {
    if (this.confirm) {
      this.confirm = null;
      this.host.update();
      return true;
    }
    if (this.review && !this.committing) {
      this.cancelReview();
      return true;
    }
    if (this.detailId && this.tab === "marketplace") {
      this.closeDetail();
      return true;
    }
    return false;
  }
}

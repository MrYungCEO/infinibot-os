/**
 * Plugins page — RPC payload types + small formatting helpers.
 * Mirrors src/gateway/server-methods/plugins.ts.
 */

import type { PluginListItem } from "../../plugin-host.js";

/** Manifest `listing` as served by plugins.list (image paths already URLs). */
export type PluginListingUi = {
  tagline?: string;
  description?: string;
  category?: string;
  tags: string[];
  cover?: string;
  icon?: string;
  screenshots: { src: string; caption?: string }[];
  publisher?: { name: string; url?: string };
  links: { docs?: string; support?: string; source?: string };
};

export type PluginSummary = PluginListItem & {
  source: string;
  origin: string;
  /** Older gateways omit everything below; the page falls back gracefully. */
  kind?: string;
  category?: string;
  listing?: PluginListingUi;
  channels?: string[];
  providers?: string[];
  setup?: { needed: boolean; reason?: string; target?: "settings" | "channels" };
  /** Hosted cloud only: the tenant plan / cloud availability decision. */
  cloud?: PluginCloudDecision | null;
  /** Paid gate (KinglyVault entitlement). Older gateways omit it. */
  access?: PluginAccess;
};

export type PluginAccess = {
  status: "free" | "unlocked" | "grace" | "locked-purchase" | "expired";
  loadable: boolean;
  reason?: string;
  requires: { purchase: boolean };
  price: { priceCents: number; currency: "USD"; label: string } | null;
  source?: string;
  until?: string | null;
  graceEndsAt?: string | null;
};

/** plugins.catalog (v1) — only the fields the page reads. */
export type CatalogPluginUi = {
  id: string;
  badges: string[];
  recommended: { score: number; reasons: string[] } | null;
  adds: { pages: { tab: string; label: string; route: string }[]; agents: string[]; tools: number; panels: number };
  access: PluginAccess;
};
export type PluginCatalog = {
  version: 1;
  plugins: CatalogPluginUi[];
  recommended: string[];
  profile: { source: "onboarding" | "default"; useCases: string[] };
  counts: { installed: number; enabled: number; updates: number; locked: number; paid: number; new: number };
  account: { linked: boolean; email: string | null; state: string };
  kinglyVault: { webUrl: string };
};

export type EntitlementSummary = {
  linked: boolean;
  state: "none" | "invalid" | "valid" | "grace" | "expired";
  account: { id: string; email: string | null } | null;
  items: Array<{ pluginId: string; source: string; until: string | null; active: boolean }>;
  expiresAt: string | null;
  graceEndsAt: string | null;
  verifiedAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  canRefresh: boolean;
  invalidReason?: string;
  /** Signed owner/admin grant for this machine (gateway owner-grant.ts). */
  ownerGrant?: { active: boolean; state: string; subject: string | null; expiresAt: string | null } | null;
  kinglyVault?: { webUrl: string };
};

export type PurchaseUrls = { buy: string | null; link: string; manage: string; ceo: string };

export type PluginCloudDecision = {
  status: "allowed" | "locked" | "coming-soon" | "self-host-only" | "unsupported";
  loadable: boolean;
  reason?: string;
  plan: string | null;
  /** Gated permissions the platform never grants here (key → why). */
  blockedPermissions?: Record<string, string>;
  /** Features of this plugin that stay self-hosted only on the cloud (absent = none). */
  selfHostOnlyFeatures?: Array<{ feature: string; why: string }>;
  /** Set by the UI when the plan leaves out a channel this plugin provides (Free: telegram, slack). */
  lockedChannel?: string;
};

export type ContributionState = {
  key: string;
  kind: string;
  kindLabel: string;
  /** Plural group heading ("Nav entries"); older gateways omit it. */
  kindGroupLabel?: string;
  id: string;
  label: string;
  detail?: string;
  toggleable: boolean;
  live: boolean;
  requires: string[];
  defaultEnabled?: boolean;
  enabled: boolean;
  offReason?: "owner" | "permission";
  blockedBy?: string[];
};

export type PermissionState = {
  key: string;
  category: "network" | "fs" | "exec" | "secrets" | "channels" | "credits" | "gated";
  value?: string;
  /** Display label of a gated (default-off) permission. */
  label?: string;
  consent: string;
  granted: boolean;
  /** Off until the owner grants it (manifest `permissions.gated`). */
  defaultOff?: boolean;
  dependents: string[];
};

export type AppearanceLayoutOption = {
  id: string;
  label: string;
  type: "select" | "toggle";
  options?: { value: string; label: string }[];
  default: string | boolean;
};

export type AppearanceVariable = {
  name: string;
  label: string;
  type: "color" | "length" | "number" | "select";
  default: string | number;
  role?: string;
  options?: string[];
  min?: number;
  max?: number;
};

export type ResolvedAppearance = {
  pluginId: string;
  values: {
    accent: string;
    tint: string;
    tintStrength: number;
    density: "compact" | "comfortable";
    fontScale: number;
    icon?: string;
    monogram?: string;
    layout: Record<string, string | boolean>;
    variables: Record<string, string | number>;
  };
  defaults: {
    accent: string;
    tint: string;
    tintStrength: number;
    density: "compact" | "comfortable";
    fontScale: number;
    icon?: string;
    monogram?: string;
    layout: AppearanceLayoutOption[];
    variables: AppearanceVariable[];
  };
  customized: boolean;
  themes: Record<"dark" | "light", { vars: Record<string, string>; contrast: Record<string, number> }>;
  adjustments: { theme: string; field: string; from: string; to: string; reason: string }[];
};

export type PluginDetail = {
  plugin: PluginSummary;
  homepage?: string;
  /** listing fields dropped as malformed (shown in Health). */
  listingWarnings?: string[];
  /** Install time, else when the plugin's files last changed (ISO). */
  updatedAt?: string;
  pluginApiVersion: string;
  pluginApiRange?: string;
  contributions: ContributionState[];
  permissions: PermissionState[];
  importers: { id: string; label: string; description?: string; method: string; accept?: string; input?: "file" | "none" }[];
  config: { hasSchema: boolean; secretKeys: string[] };
  appearance?: ResolvedAppearance;
  versions: {
    current?: string;
    source: string;
    installedAt?: string;
    spec?: string;
    updateAvailable: string | null;
    updateCheck: string;
    rollbackAvailable: boolean;
    /** Package installs / registry-managed plugins (newer gateways). */
    sha256?: string;
    sourceUrl?: string;
    registryUrl?: string;
    overridesBundled?: boolean;
    managed?: boolean;
    checkedAt?: string | null;
    latestVersion?: string;
    blocked?: string;
    paid?: boolean;
    changelog?: { version: string; releasedAt?: string; notes: string }[];
    previousVersion?: string;
    autoUpdate?: boolean;
    pendingRestart?: string | null;
    minHostVersion?: string;
  };
  data: { dir: string; exists: boolean; bytes: number; files: number };
  restartNotes: { enable: string; config: string; uninstall: string; live: string };
};

export type PluginHealth = {
  status: string;
  enabled: boolean;
  error?: string;
  health: { state: string; reason?: string };
  services: { id: string; running: boolean; startedAt?: number; lastError?: string }[];
  sidecars: { id: string; image?: string; status: string; note: string }[];
  rpc: { declared: number; registered: number; missing: string[] };
  httpRoutes: string[];
  tools: string[];
  diagnostics: { level: string; message: string }[];
  lastErrors: { ts: number; level: string; message: string }[];
};

export type PluginLogLine = { ts: number; level: string; message: string; source?: string };

export type ConfigPayload = {
  schema: Record<string, unknown> | null;
  uiHints: Record<string, { label?: string; help?: string; sensitive?: boolean; placeholder?: string; advanced?: boolean }>;
  values: Record<string, unknown>;
  secretKeys: string[];
  restartOnSave: boolean;
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function monogramOf(p: Pick<PluginSummary, "name" | "id" | "appearance">): string {
  if (p.appearance?.monogram) return p.appearance.monogram;
  const words = (p.name || p.id).replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  const caps = (p.name || p.id).match(/[A-Z]/g);
  if (words.length === 1 && caps && caps.length >= 2) return caps.slice(0, 2).join("");
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export const TIER_LABELS: Record<string, string> = {
  "first-party": "First-party",
  verified: "Verified",
  community: "Community",
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

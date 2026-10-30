/**
 * Plugins marketplace — pure view model (no Lit, no DOM) so it is unit
 * tested in the node suite: filtering, grouping into store sections, card
 * status + primary action, permission risk wording and the settings diff.
 *
 * "Installed" vs "Available" with no registry yet: a plugin is installed when
 * it is on, or was added by the owner (not bundled). Bundled plugins that are
 * off are "available" — they ship with InfiniBot and turn on in one click.
 * Registry entries (Phase 3) will join "available" through the same shape.
 */

import { channelLockReason, lockedChannelOf } from "../../cloud/plan-channels-model.js";
import type { PermissionState, PluginSummary } from "./api.js";

export type BrowseFilter = "all" | "installed" | "enabled" | "available";
export type SortKey = "recommended" | "name" | "status" | "category";
export type Tier = "first-party" | "verified" | "community";

export type BrowseQuery = {
  q: string;
  filter: BrowseFilter;
  category: string | null;
  tiers: Tier[];
  sort: SortKey;
};

export const DEFAULT_QUERY: BrowseQuery = {
  q: "",
  filter: "all",
  category: null,
  tiers: [],
  sort: "recommended",
};

export const FILTERS: { id: BrowseFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "enabled", label: "Enabled" },
  { id: "available", label: "Available" },
];

export const SORTS: { id: SortKey; label: string }[] = [
  { id: "recommended", label: "Recommended" },
  { id: "name", label: "Name A–Z" },
  { id: "status", label: "Status" },
  { id: "category", label: "Category" },
];

/** Known store categories, in section order. Unknown slugs follow, title-cased. */
export const CATEGORY_META: Record<string, { label: string; blurb: string }> = {
  apps: { label: "Apps", blurb: "Full apps with their own pages, agents and data." },
  channels: { label: "Channels", blurb: "Talk to InfiniBot from the chat apps you already use." },
  integrations: { label: "Integrations", blurb: "Model providers, memory backends and connected services." },
  developer: { label: "Developer", blurb: "Tools, workflows and diagnostics for builders." },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

/**
 * Store category. Gateways with listing support send it (declared or
 * inferred server-side); older gateways don't, so infer the same way from
 * what the summary does carry.
 */
export function categoryOf(p: Pick<PluginSummary, "category" | "contributes" | "ui" | "description" | "channels" | "providers" | "kind">): string {
  if (p.category) return p.category;
  if (p.channels?.length) return "channels";
  if (p.providers?.length || p.kind === "memory") return "integrations";
  if (p.contributes?.pages?.length || p.ui) return "apps";
  const d = p.description ?? "";
  if (/\bchannel\b/i.test(d)) return "channels";
  if (/\b(provider|oauth|memory)\b/i.test(d)) return "integrations";
  return "developer";
}

export function categoryLabel(cat: string): string {
  return CATEGORY_META[cat]?.label ?? cat.replace(/(^|-)([a-z])/g, (_, s: string, c: string) => `${s ? " " : ""}${c.toUpperCase()}`);
}

export function tierOf(p: Pick<PluginSummary, "tier">): Tier {
  return p.tier ?? "community";
}

export function isInstalled(p: Pick<PluginSummary, "enabled" | "origin">): boolean {
  return p.enabled || p.origin !== "bundled";
}

export function matchesFilter(p: PluginSummary, filter: BrowseFilter): boolean {
  switch (filter) {
    case "installed":
      return isInstalled(p);
    case "enabled":
      return p.enabled;
    case "available":
      return !isInstalled(p);
    default:
      return true;
  }
}

function haystack(p: PluginSummary): string {
  return [
    p.name,
    p.id,
    p.description,
    p.listing?.tagline,
    p.publisher,
    p.listing?.publisher?.name,
    categoryLabel(categoryOf(p)),
    ...(p.listing?.tags ?? []),
    ...(p.channels ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function matchesQuery(p: PluginSummary, q: string): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(p);
  return terms.every((t) => hay.includes(t));
}

function recommendedRank(p: PluginSummary): number {
  // On first, then first-party, then things that need attention.
  return (p.enabled ? 0 : 4) + (tierOf(p) === "first-party" ? 0 : tierOf(p) === "verified" ? 1 : 2);
}

const STATUS_RANK: Record<CardStatusKind, number> = {
  error: 0,
  setup: 1,
  applying: 2,
  update: 3,
  degraded: 4,
  on: 5,
  off: 6,
  paid: 7,
  locked: 7,
  soon: 8,
  selfhost: 9,
};

export function sortPlugins(list: PluginSummary[], sort: SortKey): PluginSummary[] {
  const byName = (a: PluginSummary, b: PluginSummary) => a.name.localeCompare(b.name);
  const out = [...list];
  switch (sort) {
    case "name":
      return out.sort(byName);
    case "status":
      return out.sort((a, b) => STATUS_RANK[cardStatus(a).kind] - STATUS_RANK[cardStatus(b).kind] || byName(a, b));
    case "category":
      return out.sort((a, b) => categoryRank(categoryOf(a)) - categoryRank(categoryOf(b)) || byName(a, b));
    default:
      return out.sort((a, b) => recommendedRank(a) - recommendedRank(b) || byName(a, b));
  }
}

function categoryRank(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

export function applyQuery(plugins: PluginSummary[], query: BrowseQuery): PluginSummary[] {
  return sortPlugins(
    plugins.filter(
      (p) =>
        matchesFilter(p, query.filter) &&
        matchesQuery(p, query.q) &&
        (!query.category || categoryOf(p) === query.category) &&
        (!query.tiers.length || query.tiers.includes(tierOf(p))),
    ),
    query.sort,
  );
}

export function isDefaultQuery(q: BrowseQuery): boolean {
  return !q.q.trim() && q.filter === "all" && !q.category && !q.tiers.length;
}

export function filterCounts(plugins: PluginSummary[]): Record<BrowseFilter, number> {
  return {
    all: plugins.length,
    installed: plugins.filter(isInstalled).length,
    enabled: plugins.filter((p) => p.enabled).length,
    available: plugins.filter((p) => !isInstalled(p)).length,
  };
}

/** Categories present in the list, known ones first. */
export function presentCategories(plugins: PluginSummary[]): { id: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of plugins) counts.set(categoryOf(p), (counts.get(categoryOf(p)) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
    .map(([id, count]) => ({ id, label: categoryLabel(id), count }));
}

export type Section = { id: string; title: string; blurb?: string; plugins: PluginSummary[] };

/**
 * Store sections for the default browse view: one per category ("apps" by
 * first-party publishers reads "First-party apps"). Sorted within a section
 * by the chosen sort.
 */
export function groupSections(list: PluginSummary[]): Section[] {
  const by = new Map<string, PluginSummary[]>();
  for (const p of list) {
    const cat = categoryOf(p);
    by.set(cat, [...(by.get(cat) ?? []), p]);
  }
  return [...by]
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
    .map(([cat, plugins]) => {
      const firstParty = cat === "apps" && plugins.every((p) => tierOf(p) === "first-party");
      return {
        id: cat,
        title: firstParty ? "First-party apps" : categoryLabel(cat),
        blurb: CATEGORY_META[cat]?.blurb,
        plugins,
      };
    });
}

// ── card status + primary action ────────────────────────────────────────

export type CardStatusKind =
  | "on"
  | "off"
  | "setup"
  | "update"
  | "error"
  | "degraded"
  | "applying"
  | "locked"
  | "soon"
  | "selfhost"
  | "paid";
export type CardStatus = { kind: CardStatusKind; label: string; detail?: string };

/** Paid gate as a card status, or null when it doesn't block. */
export function accessBlock(p: PluginSummary): CardStatus | null {
  const a = p.access;
  if (!a || a.loadable) return null;
  if (a.status === "expired") return { kind: "locked", label: "Reconnect to unlock", detail: a.reason };
  return { kind: "paid", label: "Locked", detail: a.reason };
}

/** Badge text for a paid plugin's cover ("$19", "Owned", "Included", "Owner"). */
export function accessBadge(p: PluginSummary): { kind: "paid" | "owned" | "grace"; label: string } | null {
  const a = p.access;
  if (!a || !a.requires.purchase || a.status === "free") return null;
  if (a.status === "grace") return { kind: "grace", label: "Offline grace" };
  if (a.loadable) {
    if (a.source === "admin:owner") return { kind: "owned", label: "Owner" };
    if (a.source && /^plan:(ceo|gold|owner)$/.test(a.source)) return { kind: "owned", label: "Included with your CEO plan" };
    return { kind: "owned", label: a.source?.startsWith("plan:") || a.source === "admin" ? "Included" : "Owned" };
  }
  return { kind: "paid", label: a.price ? a.price.label : "Paid" };
}

/** Hosted cloud: a plugin the tenant can't turn on (plan / not in cloud yet). */
export function cloudBlock(p: PluginSummary): CardStatus | null {
  const c = p.cloud;
  if (!c || c.loadable) return null;
  if (c.status === "locked") return { kind: "locked", label: "Upgrade to unlock", detail: c.reason };
  if (c.status === "self-host-only") return { kind: "selfhost", label: "Self-hosted only", detail: c.reason };
  return { kind: "soon", label: "Coming soon", detail: c.reason };
}

/** Hosted cloud: features of a cloud-available plugin that stay self-hosted only. */
export function cloudSelfHostFeatures(p: PluginSummary): Array<{ feature: string; why: string }> {
  const c = p.cloud;
  if (!c || c.status === "coming-soon" || c.status === "self-host-only" || c.status === "unsupported") return [];
  return c.selfHostOnlyFeatures ?? [];
}

/**
 * Hosted plans that leave a channel out (Free: Telegram, Slack): a plugin that
 * provides one shows locked with the upgrade instead of an Enable toggle. A
 * decision the server already made that blocks the plugin is kept as is; an
 * empty `excluded` (self-hosted, paid plans) returns the list untouched.
 */
export function applyPlanChannelLocks(plugins: PluginSummary[], excluded: readonly string[]): PluginSummary[] {
  if (!excluded.length) return plugins;
  return plugins.map((p) => {
    const ch = lockedChannelOf(p, excluded);
    if (!ch) return p;
    // Coming soon / self-host only stays what the server said.
    if (p.cloud && !p.cloud.loadable && p.cloud.status !== "locked") return p;
    const serverLocked = p.cloud?.status === "locked" && !p.cloud.loadable;
    return {
      ...p,
      cloud: {
        ...(p.cloud ?? {}),
        status: "locked",
        loadable: false,
        reason: serverLocked && p.cloud?.reason ? p.cloud.reason : channelLockReason(ch),
        plan: p.cloud?.plan ?? "free",
        lockedChannel: ch,
      },
    };
  });
}

export function cardStatus(p: PluginSummary, pending?: boolean): CardStatus {
  if (pending) return { kind: "applying", label: "Applying…" };
  const blocked = cloudBlock(p) ?? accessBlock(p);
  if (blocked) return blocked;
  if (p.status === "error") return { kind: "error", label: "Error", detail: p.error };
  if (!p.enabled) return { kind: "off", label: "Off" };
  if (p.setup?.needed) return { kind: "setup", label: "Needs setup", detail: p.setup.reason };
  if (p.updateAvailable) return { kind: "update", label: "Update available", detail: `Version ${p.updateAvailable}` };
  if (p.health?.state === "degraded") return { kind: "degraded", label: "Degraded", detail: p.health.reason };
  return { kind: "on", label: "On" };
}

export type PrimaryAction =
  | { kind: "buy"; label: string }
  | { kind: "enable"; label: string }
  | { kind: "open"; label: string; tab: string }
  | { kind: "channels"; label: string }
  | { kind: "details"; label: string; section?: string }
  /** A channel the plan leaves out: straight into the upgrade checkout. */
  | { kind: "upgrade"; label: string };

/** The page tab a plugin opens: its first nav entry, else its first page. */
export function openTabOf(p: PluginSummary): string | undefined {
  return p.contributes?.nav?.[0]?.tab ?? p.contributes?.pages?.[0]?.tab;
}

export function primaryAction(p: PluginSummary, pending?: boolean): PrimaryAction {
  if (pending) return { kind: "details", label: "Manage" };
  const blocked = cloudBlock(p);
  if (blocked) {
    if (p.cloud?.lockedChannel) return { kind: "upgrade", label: "Upgrade" };
    return { kind: "details", label: blocked.kind === "locked" ? "Upgrade" : "Details" };
  }
  const gated = accessBlock(p);
  if (gated) {
    if (gated.kind === "paid") return { kind: "buy", label: p.access?.price ? `Buy · ${p.access.price.label}` : "Buy" };
    if (gated.kind === "locked") return { kind: "buy", label: "Restore" };
    return { kind: "details", label: "Details" };
  }
  if (p.status === "error") return { kind: "details", label: "Fix", section: "health" };
  if (!p.enabled) return { kind: "enable", label: "Enable" };
  if (p.setup?.needed)
    return p.setup.target === "channels"
      ? { kind: "channels", label: "Set up" }
      : { kind: "details", label: "Set up", section: "settings" };
  const tab = p.status === "loaded" ? openTabOf(p) : undefined;
  if (tab) return { kind: "open", label: "Open", tab };
  return { kind: "details", label: "Configure", section: "settings" };
}

// ── permissions ─────────────────────────────────────────────────────────

export type Risk = "high" | "medium" | "low";
export type PermissionCopy = { title: string; explain: string; risk: Risk };

/** Plain-English wording + risk level for one requested permission. */
export function describePermission(perm: Pick<PermissionState, "category" | "value"> & { label?: string }): PermissionCopy {
  const v = perm.value;
  switch (perm.category) {
    case "gated":
      return {
        title: perm.label ?? (v ? `Allow ${v}` : "Sensitive capability"),
        explain: "Off by default. Nothing that needs it runs until you turn it on.",
        risk: "high",
      };
    case "exec":
      return {
        title: "Run commands on this machine",
        explain: "Can start programs and shell commands with the same access as InfiniBot.",
        risk: "high",
      };
    case "secrets":
      return {
        title: v ? `Use the stored secret ${v}` : "Use stored secrets",
        explain: "Can read this saved credential (an API key or token) to act on your behalf.",
        risk: "high",
      };
    case "fs": {
      const broad = !v || v === "/" || v === "~" || v === "*";
      return {
        title: v ? `Read and write files in ${v}` : "Read and write files",
        explain: broad
          ? "Can read and change files anywhere this path reaches."
          : "Can read and change files inside this folder only.",
        risk: broad ? "high" : "medium",
      };
    }
    case "network": {
      const any = !v || v === "*";
      return {
        title: any ? "Connect to any website" : `Connect to ${v}`,
        explain: any
          ? "Can send and receive data from any internet host."
          : "Can send and receive data from this internet host only.",
        risk: any ? "medium" : "low",
      };
    }
    case "channels":
      return {
        title: v ? `Send and read messages on ${v}` : "Send and read messages on your channels",
        explain: "Can post as InfiniBot and read incoming messages on this channel.",
        risk: "medium",
      };
    case "credits":
      return {
        title: "Spend credits",
        explain: "Can use paid model or service credits on your account.",
        risk: "medium",
      };
    default:
      return { title: v ? `${perm.category}: ${v}` : String(perm.category), explain: "", risk: "medium" };
  }
}

const RISK_ORDER: Record<Risk, number> = { high: 0, medium: 1, low: 2 };

/** Highest risk first, request order kept within a level. */
export function sortPermissionsByRisk<T extends Pick<PermissionState, "category" | "value">>(perms: T[]): T[] {
  return perms
    .map((p, i) => ({ p, i, r: RISK_ORDER[describePermission(p).risk] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

/** A default-off (gated) permission is not "revoked" until the owner acts. */
export function isDefaultOffPermission(perm: Pick<PermissionState, "category" | "defaultOff">): boolean {
  return perm.defaultOff ?? perm.category === "gated";
}

/** Status label: Granted, Off by default (gated, never granted) or Revoked. */
export function permissionStatusLabel(perm: Pick<PermissionState, "category" | "defaultOff" | "granted">): string {
  if (perm.granted) return "Granted";
  return isDefaultOffPermission(perm) ? "Off by default" : "Revoked";
}

export const RISK_LABEL: Record<Risk, string> = { high: "High risk", medium: "Medium", low: "Low" };

export function permissionSummary(perms: PermissionState[]): { requested: number; granted: number; high: number } {
  return {
    requested: perms.length,
    granted: perms.filter((p) => p.granted).length,
    high: perms.filter((p) => describePermission(p).risk === "high").length,
  };
}

// ── settings diff ───────────────────────────────────────────────────────

function isSecretMask(v: unknown): boolean {
  return Boolean(v && typeof v === "object" && (v as { __secret?: unknown }).__secret === true);
}

function stable(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Dotted paths whose draft value differs from the saved one. A secret counts
 * as changed only when a new value was typed (the saved one is a mask).
 * Nested objects are compared one level down so the bar can say "3 changes".
 */
export function configChanges(
  saved: Record<string, unknown>,
  draft: Record<string, unknown>,
  secretKeys: string[] = [],
): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  for (const k of [...keys].sort()) {
    const a = saved[k];
    const b = draft[k];
    if (secretKeys.includes(k)) {
      if (typeof b === "string" && b !== "" && !isSecretMask(b)) out.push(k);
      continue;
    }
    const aObj = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
    const bObj = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    if (aObj || bObj) {
      const sub = new Set([...Object.keys(aObj ?? {}), ...Object.keys(bObj ?? {})]);
      for (const s of [...sub].sort()) {
        if (stable(aObj?.[s]) !== stable(bObj?.[s])) out.push(`${k}.${s}`);
      }
      continue;
    }
    if (stable(a) !== stable(b)) out.push(k);
  }
  return out;
}

// ── detail page sections ────────────────────────────────────────────────

export const DETAIL_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "contributions", label: "What it adds" },
  { id: "permissions", label: "Permissions" },
  { id: "settings", label: "Settings" },
  { id: "appearance", label: "Appearance" },
  { id: "health", label: "Health & Logs" },
  { id: "data", label: "Data" },
  { id: "versions", label: "Versions" },
  { id: "uninstall", label: "Uninstall" },
] as const;

export type DetailSectionId = (typeof DETAIL_SECTIONS)[number]["id"];

export function isDetailSection(id: string | null | undefined): id is DetailSectionId {
  return DETAIL_SECTIONS.some((s) => s.id === id);
}

/** "2026-09-28T…" → "Sep 28, 2026" (locale-aware), or undefined. */
export function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

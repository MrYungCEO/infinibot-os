/**
 * Plugins page catalog + KinglyVault entitlements.
 *
 *   plugins.catalog                    one stable, read-scoped list for the
 *                                      Plugins page, onboarding and the nav
 *   plugins.entitlements.status        linked KinglyVault account + purchases
 *   plugins.entitlements.import        { token, refreshToken?, apiUrl? } from
 *                                      the KinglyVault link/buy redirect
 *   plugins.entitlements.refresh       re-check with KinglyVault now
 *   plugins.entitlements.unlink        forget the account on this install
 *   plugins.purchase.urls              { id?, returnUrl } → KinglyVault buy /
 *                                      link / manage URLs
 *   plugins.kv.status                  { capabilities, account, connect }:
 *                                      is "Connect KinglyVault" live, who is
 *                                      linked, any code waiting for approval
 *   plugins.kv.connect.start           device code + approval page (the UI
 *                                      opens it in the normal browser); the
 *                                      gateway polls until approved
 *   plugins.kv.connect.status { id }   pending | approved | denied | expired
 *   plugins.kv.connect.cancel { id }
 *
 * ── plugins.catalog shape (v1; additive changes only) ───────────────────────
 *
 *   {
 *     version: 1,
 *     generatedAt: ISO,
 *     plugins: CatalogPlugin[],          // sorted: recommended first, then name
 *     categories: { id, label, count }[],
 *     recommended: string[],             // plugin ids, best first (≤ 6)
 *     profile: { source: "onboarding" | "default", useCases: string[] },
 *     counts: { installed, enabled, updates, locked, paid, new },
 *     account: { linked, email, state },  // KinglyVault link (no secrets)
 *     kinglyVault: { webUrl }
 *   }
 *
 *   CatalogPlugin = {
 *     id, name, version, tagline, description, category, tags[], icon, cover,
 *     publisher, enabled, status, loaded,
 *     access: PluginAccessDecision,      // entitlements/access.ts
 *     badges: ("new"|"update"|"paid"|"pro"|"locked"|"owned")[],
 *     adds: { pages: {tab,label,route}[], agents: string[], tools: number, panels: number },
 *     updateAvailable: string | null,
 *     recommended: { score, reasons: string[] } | null,
 *     detailRoute: "/plugins?plugin=<id>"
 *   }
 *
 * Onboarding profile (owned by onboarding; read-only here): JSON at
 * `<state dir>/onboarding-profile.json` (or `<shared dir>/…`), shape
 * `{ useCases?: string[], industry?: string, goals?: string[] }`. Missing or
 * malformed → a sensible default list.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type InfinibotConfig } from "../../config/config.js";
import { resolveSharedDir, resolveStateDir } from "../../config/paths.js";
import {
  pluginAccessDecision,
  type PluginAccessDecision,
} from "../../plugins/entitlements/access.js";
import {
  entitlementSummary,
  importEntitlementToken,
  kinglyVaultWebUrl,
  readEntitlementFile,
  refreshDue,
  refreshEntitlements,
  unlinkEntitlements,
} from "../../plugins/entitlements/store.js";
import {
  activeKvConnect,
  cancelKvConnect,
  getKvConnect,
  kvCapabilities,
  revokeKvDeviceLink,
  startKvConnect,
} from "../../plugins/entitlements/kv-connect.js";
import {
  linkEntitlementsFromRelay,
  readRelayLink,
  relayStatePath,
} from "../../plugins/entitlements/relay-link.js";
import { resolveListingForUi } from "../../plugins/listing.js";
import type { PluginRecord } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { readUpdateState } from "../../plugins/packages/store.js";
import { appendPluginLog } from "../../plugins/plugin-logs.js";
import { bad, scheduleRestart } from "./plugins.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── recommendations ─────────────────────────────────────────────────────────

/** use-case keyword → plugins it suggests (first match strongest). */
const USE_CASE_RULES: ReadonlyArray<{ match: RegExp; ids: string[]; label: string }> = [
  { match: /^phones?$|android|device farm/i, ids: ["droid-swarm"], label: "running phones" },
  { match: /^media$/i, ids: ["flypic", "content-studio"], label: "images and video" },
  { match: /^assistant$/i, ids: ["discipline", "business-agency"], label: "a personal assistant" },
  {
    match: /content|social|creator|influenc|post|reel|youtube|tiktok|instagram|marketing|brand/i,
    ids: ["content-studio", "flypic", "droid-swarm"],
    label: "content and social",
  },
  {
    match: /agency|client|business|sales|crm|lead|freelanc|consult|service/i,
    ids: ["business-agency", "products"],
    label: "running a business",
  },
  { match: /voice|call|phone|reception|support/i, ids: ["robovoice"], label: "voice and calls" },
  {
    match: /code|coding|develop|engineer|software|devops|repo/i,
    ids: ["infinicode", "whiteboard"],
    label: "building software",
  },
  {
    match: /trad|crypto|stock|forex|financ|invest|solana/i,
    ids: ["infinitrade", "solatrix"],
    label: "trading and finance",
  },
  {
    match: /clinic|health|medical|doctor|patient|dental/i,
    ids: ["omniclinic"],
    label: "clinics and health",
  },
  {
    match: /image|video|design|art|photo|visual/i,
    ids: ["flypic", "canvas-library", "whiteboard"],
    label: "visual creation",
  },
  {
    match: /habit|productiv|focus|goal|discipline|personal/i,
    ids: ["discipline"],
    label: "personal productivity",
  },
  {
    match: /e-?commerce|shop|store|product/i,
    ids: ["products", "content-studio"],
    label: "selling products",
  },
];

const DEFAULT_RECOMMENDED = ["business-agency", "content-studio", "flypic", "robovoice"];

export type OnboardingProfile = {
  source: "onboarding" | "default";
  useCases: string[];
  /** Plugins onboarding itself recommended (onboarding.profile `plugins`). */
  plugins?: string[];
};

/**
 * The onboarding use-case profile (owned by onboarding: onboarding.profile.set
 * writes `<state dir>/onboarding/profile.json`). Older/alternate locations are
 * tried after it. Missing or malformed → the default list.
 */
export function readOnboardingProfile(env: NodeJS.ProcessEnv = process.env): OnboardingProfile {
  const candidates = [
    path.join(resolveStateDir(env), "onboarding", "profile.json"),
    path.join(resolveStateDir(env), "onboarding-profile.json"),
    path.join(resolveSharedDir(env), "onboarding-profile.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const list = (v: unknown) =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
          : [];
      const useCases = [
        ...list(raw.useCases),
        ...list(raw.goals),
        ...(typeof raw.industry === "string" && raw.industry.trim() ? [raw.industry] : []),
      ]
        .map((s) => s.trim().slice(0, 80))
        .slice(0, 20);
      const plugins = list(raw.plugins)
        .filter((x) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(x))
        .slice(0, 12);
      if (useCases.length || plugins.length) return { source: "onboarding", useCases, plugins };
    } catch {
      // missing or malformed → next / default
    }
  }
  return { source: "default", useCases: [] };
}

export function recommendFor(
  profile: OnboardingProfile,
  available: readonly string[],
): Map<string, { score: number; reasons: string[] }> {
  const out = new Map<string, { score: number; reasons: string[] }>();
  const have = new Set(available);
  const add = (id: string, score: number, reason: string) => {
    if (!have.has(id)) return;
    const cur = out.get(id) ?? { score: 0, reasons: [] };
    cur.score += score;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    out.set(id, cur);
  };
  if (profile.source === "onboarding") {
    // Onboarding's own picks first, in its order.
    (profile.plugins ?? []).forEach((id, i) => add(id, 20 - i, "Picked for you during setup"));
    for (const uc of profile.useCases) {
      for (const rule of USE_CASE_RULES) {
        if (!rule.match.test(uc)) continue;
        rule.ids.forEach((id, i) => add(id, 10 - i * 2, `Fits ${rule.label}`));
      }
    }
  }
  if (out.size === 0) {
    DEFAULT_RECOMMENDED.forEach((id, i) => add(id, 5 - i, "Popular with new InfiniBot users"));
  }
  return out;
}

// ── "new" badge ─────────────────────────────────────────────────────────────

const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * First-seen time per plugin id (<shared dir>/plugins-seen.json). The first
 * catalog call seeds every current plugin as "old", so only plugins that
 * arrive later get the New badge.
 */
export function firstSeenMap(ids: readonly string[], now = Date.now(), env = process.env) {
  const file = path.join(resolveSharedDir(env), "plugins-seen.json");
  let seen: Record<string, number> | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) seen = raw as Record<string, number>;
  } catch {
    seen = null;
  }
  const seeding = seen === null;
  const map: Record<string, number> = { ...seen };
  let dirty = seeding;
  for (const id of ids) {
    if (typeof map[id] !== "number") {
      map[id] = seeding ? 0 : now;
      dirty = true;
    }
  }
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(map)}\n`);
    } catch {
      // read-only state dir: no New badges, nothing else breaks
    }
  }
  return (id: string) => (map[id] ?? 0) > 0 && now - (map[id] ?? 0) < NEW_FOR_MS;
}

// ── catalog ─────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  apps: "Apps",
  channels: "Channels",
  integrations: "Integrations",
  developer: "Developer",
};

export type CatalogPlugin = {
  id: string;
  name: string;
  version: string | null;
  tagline: string | null;
  description: string | null;
  category: string;
  tags: string[];
  icon: string | null;
  cover: string | null;
  publisher: string | null;
  enabled: boolean;
  status: string;
  loaded: boolean;
  access: PluginAccessDecision;
  badges: string[];
  adds: {
    pages: { tab: string; label: string; route: string }[];
    agents: string[];
    tools: number;
    panels: number;
  };
  updateAvailable: string | null;
  recommended: { score: number; reasons: string[] } | null;
  detailRoute: string;
};

function configEnabled(cfg: InfinibotConfig | undefined, id: string): boolean {
  const entry = (cfg?.plugins?.entries as Record<string, { enabled?: boolean }> | undefined)?.[id];
  return entry?.enabled === true;
}

export function buildCatalog(
  records: readonly PluginRecord[],
  opts: { cfg?: InfinibotConfig; now?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const seen = new Set<string>();
  const unique = records.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  // The catalog is the store: apps and integrations people choose. Channels
  // and auth/provider shims stay on their own setup pages.
  const updates = readUpdateState();
  const profile = readOnboardingProfile(env);
  const rec = recommendFor(
    profile,
    unique.map((r) => r.id),
  );
  const isNew = firstSeenMap(
    unique.map((r) => r.id),
    now,
    env,
  );
  const plugins: CatalogPlugin[] = unique.map((r) => {
    const listing = resolveListingForUi(r.id, r.listing);
    const access = pluginAccessDecision(r.id, { manifestAccess: r.manifestAccess, env, now });
    const update = updates.plugins[r.id];
    const updateAvailable = update?.updateAvailable ? (update.latestVersion ?? null) : null;
    const pages = (r.contributes?.pages ?? []).map((pg) => ({
      tab: pg.tab,
      label: r.contributes?.nav.find((n) => n.tab === pg.tab)?.label ?? pg.title ?? pg.tab,
      route: pg.route,
    }));
    const badges: string[] = [];
    if (isNew(r.id)) badges.push("new");
    if (updateAvailable) badges.push("update");
    if (access.requires.purchase) badges.push("paid");
    if (access.source?.startsWith("plan:")) badges.push("pro");
    if (!access.loadable) badges.push("locked");
    else if (access.requires.purchase) badges.push("owned");
    return {
      id: r.id,
      name: r.name,
      version: r.version ?? null,
      tagline: listing?.tagline ?? null,
      description: listing?.description ?? r.description ?? null,
      category: r.category ?? "developer",
      tags: listing?.tags ?? [],
      icon: listing?.icon ?? null,
      cover: listing?.cover ?? null,
      publisher: listing?.publisher?.name ?? (typeof r.publisher === "string" ? r.publisher : null),
      enabled: r.enabled || configEnabled(opts.cfg, r.id),
      status: r.status,
      loaded: r.status === "loaded",
      access,
      badges,
      adds: {
        pages,
        agents: r.contributes?.agents ?? [],
        tools: r.contributes?.tools.length ?? 0,
        panels: r.contributes?.panels.length ?? 0,
      },
      updateAvailable,
      recommended: rec.get(r.id) ?? null,
      detailRoute: `/plugins?plugin=${encodeURIComponent(r.id)}`,
    };
  });
  plugins.sort((a, b) => {
    const ra = a.recommended?.score ?? 0;
    const rb = b.recommended?.score ?? 0;
    if (ra !== rb) return rb - ra;
    return a.name.localeCompare(b.name);
  });
  const recommended = plugins
    .filter((p) => p.recommended && p.category !== "channels")
    .slice(0, 6)
    .map((p) => p.id);
  const catCounts = new Map<string, number>();
  for (const p of plugins) catCounts.set(p.category, (catCounts.get(p.category) ?? 0) + 1);
  const ent = entitlementSummary(now, env);
  return {
    version: 1 as const,
    generatedAt: new Date(now).toISOString(),
    plugins,
    categories: [...catCounts.entries()]
      .map(([id, count]) => ({ id, label: CATEGORY_LABELS[id] ?? id, count }))
      .sort((a, b) => b.count - a.count),
    recommended,
    profile,
    counts: {
      installed: plugins.length,
      enabled: plugins.filter((p) => p.enabled).length,
      updates: plugins.filter((p) => p.updateAvailable).length,
      locked: plugins.filter((p) => !p.access.loadable).length,
      paid: plugins.filter((p) => p.access.requires.purchase).length,
      new: plugins.filter((p) => p.badges.includes("new")).length,
    },
    account: { linked: ent.linked, email: ent.account?.email ?? null, state: ent.state },
    kinglyVault: { webUrl: kinglyVaultWebUrl(env) },
  };
}

// ── purchase URLs ───────────────────────────────────────────────────────────

/** Only http(s) return URLs, no credentials; anything else is dropped. */
export function safeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function purchaseUrls(
  params: { id?: string; returnUrl?: unknown; state?: unknown },
  env = process.env,
) {
  const web = kinglyVaultWebUrl(env);
  const ret = safeReturnUrl(params.returnUrl);
  const state =
    typeof params.state === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(params.state)
      ? params.state
      : null;
  const q = (extra: Record<string, string | null | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `?${s}` : "";
  };
  const id = params.id && /^[a-z0-9][a-z0-9-]{0,63}$/.test(params.id) ? params.id : null;
  return {
    buy: id ? `${web}/infinibot/plugins/${id}${q({ buy: "1", return: ret, state })}` : null,
    link: `${web}/infinibot/link${q({ return: ret, state, plugin: id })}`,
    manage: `${web}/infinibot/purchases`,
    ceo: `${web}/infinibot-plugins`,
  };
}

// ── restart when unlocks change what loads ──────────────────────────────────

function restartIfNeeded(changed: readonly string[], why: string) {
  if (changed.length === 0) return null;
  let cfg: InfinibotConfig | undefined;
  try {
    cfg = loadConfig();
  } catch {
    cfg = undefined;
  }
  const loaded = new Set(
    (getActivePluginRegistry()?.plugins ?? [])
      .filter((r) => r.status === "loaded")
      .map((r) => r.id),
  );
  // Restart only when something switched on in config must now load, or a
  // loaded plugin must now unload. "*" (plan-wide) affects every paid plugin.
  const wide = changed.includes("*");
  const affected = (getActivePluginRegistry()?.plugins ?? [])
    .map((r) => r.id)
    .filter((id) => wide || changed.includes(id))
    .filter((id) => {
      const d = pluginAccessDecision(id);
      return (
        d.requires.purchase &&
        (configEnabled(cfg, id) ? d.loadable !== loaded.has(id) : loaded.has(id))
      );
    });
  if (affected.length === 0) return null;
  for (const id of affected)
    appendPluginLog(id, "info", `KinglyVault entitlement changed (${why}); gateway restart`);
  return {
    ...scheduleRestart(`plugins.entitlements ${why}: ${affected.join(",")}`),
    plugins: affected,
  };
}

// ── background refresh ──────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<unknown> | null = null;

async function refreshNow(why: string) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const res = await refreshEntitlements();
    const restart = res.ok
      ? restartIfNeeded(res.changed, why)
      : res.revoked
        ? restartIfNeeded(["*"], why)
        : null;
    return { ...res, restart };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Re-check soon after the Plugins page opens if the last check is this old. */
const STALE_ON_OPEN_MS = 15 * 60_000;

function refreshIfStale() {
  const file = readEntitlementFile();
  if (!file.refreshToken) return;
  if (Date.now() - (file.lastRefreshAt ?? 0) < STALE_ON_OPEN_MS) return;
  void refreshNow("page-open").catch(() => {});
}

// ── one connection: KinglyVault Connect (relay) → plugin licence ───────────

let relayTimer: ReturnType<typeof setInterval> | null = null;
let relaySyncing: Promise<unknown> | null = null;
let relaySeen = "";
let relayLastTry = 0;
/** Retry an unreachable KinglyVault this often while not linked. */
const RELAY_RETRY_MS = 5 * 60_000;

/** Link the plugin licence from the relay pairing (no-op once linked). */
async function syncFromRelay(why: string, force = false) {
  if (relaySyncing) return relaySyncing;
  relaySyncing = (async () => {
    relayLastTry = Date.now();
    const res = await linkEntitlementsFromRelay({ force });
    if (res.ok) {
      appendPluginLog(
        "kinglyvault",
        "info",
        `plugin licence linked from KinglyVault Connect (${why})`,
      );
      return { ...res, restart: restartIfNeeded(res.changed, `relay-link ${why}`) };
    }
    return { ...res, restart: null };
  })().finally(() => {
    relaySyncing = null;
  });
  return relaySyncing;
}

function relayStamp(): string {
  try {
    const st = fs.statSync(relayStatePath());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

function relayTick() {
  if (readEntitlementFile().refreshToken) return;
  const stamp = relayStamp();
  if (!stamp) return;
  // A new pairing (state.json changed) → now; otherwise retry slowly.
  if (stamp === relaySeen && Date.now() - relayLastTry < RELAY_RETRY_MS) return;
  relaySeen = stamp;
  void syncFromRelay("auto").catch(() => {});
}

/** Hourly check; refreshes when the token is ≥ 12 h old (store.REFRESH_EVERY_MS). */
export function startEntitlementRefreshLoop(): () => void {
  if (refreshTimer) return () => {};
  const tick = () => {
    if (refreshDue()) void refreshNow("scheduled").catch(() => {});
  };
  setTimeout(tick, 30_000).unref?.();
  refreshTimer = setInterval(tick, 60 * 60 * 1000);
  refreshTimer.unref?.();
  // Already relay-paired installs get their plugin licence on this start; a
  // pairing made later is picked up within ~15 s.
  setTimeout(relayTick, 5_000).unref?.();
  relayTimer = setInterval(relayTick, 15_000);
  relayTimer.unref?.();
  return () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (relayTimer) clearInterval(relayTimer);
    refreshTimer = null;
    relayTimer = null;
  };
}

// ── handlers ────────────────────────────────────────────────────────────────

export const pluginCatalogHandlers: GatewayRequestHandlers = {
  "plugins.catalog": ({ respond }) => {
    let cfg: InfinibotConfig | undefined;
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
    respond(true, buildCatalog(getActivePluginRegistry()?.plugins ?? [], { cfg }));
  },

  "plugins.entitlements.status": ({ respond }) => {
    respond(true, {
      ...entitlementSummary(),
      kinglyVault: { webUrl: kinglyVaultWebUrl() },
      relayPaired: Boolean(readRelayLink()),
    });
  },

  /** One click: link the plugin licence from the KinglyVault Connect pairing now. */
  "plugins.entitlements.syncFromRelay": async ({ respond }) => {
    const res = readEntitlementFile().refreshToken
      ? await refreshNow("manual")
      : await syncFromRelay("manual", true);
    respond(true, { ...(res as object), summary: entitlementSummary() });
  },

  "plugins.entitlements.import": ({ params, respond }) => {
    const p = (params ?? {}) as { token?: unknown; refreshToken?: unknown; apiUrl?: unknown };
    const res = importEntitlementToken({
      token: p.token,
      refreshToken: p.refreshToken,
      apiUrl: p.apiUrl,
    });
    if (!res.ok) {
      bad(respond, res.error);
      return;
    }
    const restart = restartIfNeeded(res.changed, "import");
    respond(true, { ok: true, changed: res.changed, summary: res.summary, restart });
  },

  "plugins.entitlements.refresh": async ({ respond }) => {
    const res = (await refreshNow("manual")) as Awaited<ReturnType<typeof refreshEntitlements>> & {
      restart: unknown;
    };
    respond(true, res);
  },

  "plugins.entitlements.unlink": async ({ respond }) => {
    // Tell KinglyVault first (needs the refresh token we are about to drop).
    const revokedRemote = await revokeKvDeviceLink().catch(() => false);
    const { changed } = unlinkEntitlements();
    const restart = restartIfNeeded(changed, "unlink");
    respond(true, { ok: true, changed, summary: entitlementSummary(), restart, revokedRemote });
  },

  "plugins.kv.status": async ({ params, respond }) => {
    const force = Boolean((params as { force?: unknown } | undefined)?.force);
    const capabilities = await kvCapabilities({ force });
    refreshIfStale();
    // One connection: paired through KinglyVault Connect but no plugin licence
    // yet → link it now, so the panel opens already unlocked (bounded wait).
    const relayPaired = Boolean(readRelayLink());
    if (relayPaired && !readEntitlementFile().refreshToken && Date.now() - relayLastTry > 20_000) {
      await Promise.race([
        syncFromRelay("status").catch(() => null),
        new Promise((r) => setTimeout(r, 8_000).unref?.()),
      ]);
    }
    const summary = entitlementSummary();
    respond(true, {
      capabilities,
      account: {
        linked: summary.linked,
        email: summary.account?.email ?? null,
        state: summary.state,
        lastRefreshAt: summary.lastRefreshAt,
        lastError: summary.lastError,
        canRefresh: summary.canRefresh,
        items: summary.items,
        ownerGrant: summary.ownerGrant,
      },
      connect: activeKvConnect(),
      relayPaired,
    });
  },

  "plugins.kv.connect.start": async ({ respond }) => {
    const res = await startKvConnect({
      onLinked: ({ changed }) => restartIfNeeded(changed, "connect"),
    });
    if (!res.ok) {
      bad(respond, res.error, { code: "kv_unavailable" });
      return;
    }
    respond(true, { connect: res.connect });
  },

  "plugins.kv.connect.status": ({ params, respond }) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    const connect = typeof id === "string" ? getKvConnect(id) : null;
    if (!connect) {
      bad(respond, "that connection request is gone; start again");
      return;
    }
    respond(true, {
      connect,
      ...(connect.status === "approved" ? { summary: entitlementSummary() } : {}),
    });
  },

  "plugins.kv.connect.cancel": ({ params, respond }) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    respond(true, { ok: typeof id === "string" ? cancelKvConnect(id) : false });
  },

  "plugins.purchase.urls": ({ params, respond }) => {
    const p = (params ?? {}) as { id?: unknown; returnUrl?: unknown; state?: unknown };
    respond(
      true,
      purchaseUrls({
        id: typeof p.id === "string" ? p.id.trim() : undefined,
        returnUrl: p.returnUrl,
        state: p.state,
      }),
    );
  },
};

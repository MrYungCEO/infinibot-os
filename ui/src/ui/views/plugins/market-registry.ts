/**
 * Plugins page — the Marketplace tab's direct line to the public registry.
 *
 * The tab normally asks the gateway (`plugins.marketplace.list` / `.get`), which
 * reads the registry and annotates each entry with what this install has. When the
 * gateway can't answer (an older or serverless gateway: "unknown method", or the
 * socket is down), the tab reads the same public registry itself:
 *   GET <apiBase>/index.json        → { generatedAt, plugins: [Entry] }
 *   GET <apiBase>/plugins/<id>      → Entry & { versions }
 * (src/saas/cloud/marketplace/registry-api.ts; CORS `*`, no auth). The hosted cloud
 * build reads it first, since the registry lives on the same origin.
 *
 * Only types come from packages.ts so there is no import cycle at runtime.
 */

import type { MarketEntry, MarketPayload } from "./packages.js";

/** Same wording as the gateway (src/plugins/packages/registry-client.ts formatPrice). */
export function formatPrice(pricing: Pick<MarketEntry["pricing"], "model" | "priceCents" | "currency">): string {
  if (pricing.model === "free" || pricing.priceCents <= 0) return "Free";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: pricing.currency }).format(pricing.priceCents / 100);
  } catch {
    return `${(pricing.priceCents / 100).toFixed(2)} ${pricing.currency}`;
  }
}

/**
 * Errors that mean "this gateway can't serve the marketplace", not "the registry
 * said no": the method is missing, or the request never got an answer.
 */
export function isGatewayUnavailable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return /unknown method|method not found|not implemented|not supported|unsupported method|not connected|disconnected|socket|websocket|gateway closed|connection|timed? ?out|timeout|network|failed to fetch/.test(msg);
}

type RegistryEntry = Omit<MarketEntry, "priceLabel" | "installed" | "compatible" | "blocked">;
type Installed = { id: string; version?: string; origin: string };

function absolute(base: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** a.b.c > x.y.z, numeric parts only (pre-release tags ignored). */
function newer(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

/**
 * Registry entry → card entry, the way the gateway's list does it except for what
 * only the gateway knows: host version (`compatible` stays true; the install
 * review still checks it) and tenant install policy (`blocked` stays null).
 */
export function registryToMarketEntry(raw: RegistryEntry, origin: string, installed: Installed[]): MarketEntry {
  const ref = installed.find((p) => p.id === raw.id);
  const listing = raw.listing ?? { cover: null, icon: null, screenshots: [] };
  return {
    ...raw,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    description: raw.description ?? "",
    publisher: raw.publisher ?? { id: "", name: "", verified: false },
    listing: {
      ...listing,
      cover: absolute(origin, listing.cover),
      icon: absolute(origin, listing.icon),
      screenshots: (Array.isArray(listing.screenshots) ? listing.screenshots : [])
        .map((s) => {
          const src = absolute(origin, typeof s === "string" ? s : s?.src);
          return src ? { src, ...(typeof s === "object" && s?.caption ? { caption: s.caption } : {}) } : null;
        })
        .filter((s): s is { src: string; caption?: string } => Boolean(s)),
    },
    priceLabel: formatPrice(raw.pricing),
    installed: ref
      ? {
          version: ref.version ?? null,
          origin: ref.origin,
          package: ref.origin !== "bundled",
          updateAvailable: raw.distribution !== "external" && newer(raw.version, ref.version),
        }
      : null,
    compatible: true,
    blocked: null,
  };
}

export type RegistryDeps = {
  fetch: typeof fetch;
  /** e.g. "/api/marketplace" (cloud) or "https://cloud.infinibotos.com/api/marketplace". */
  apiBase: string;
  installed: () => Installed[];
};

/** Registry origin ("" base → this page's origin), used for URLs and the source label. */
function originOf(apiBase: string): string {
  const here = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  try {
    return new URL(apiBase, here).origin;
  } catch {
    return here;
  }
}

async function getJson(deps: RegistryDeps, path: string): Promise<unknown> {
  const res = await deps.fetch(`${deps.apiBase.replace(/\/+$/, "")}${path}`, {
    credentials: "omit",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error("not in the marketplace");
    throw new Error(`the marketplace registry answered ${res.status}`);
  }
  return res.json();
}

/** The registry index as a Marketplace tab payload. Throws when it can't be read. */
export async function loadRegistryMarket(deps: RegistryDeps): Promise<MarketPayload> {
  const body = (await getJson(deps, "/index.json")) as { generatedAt?: string; plugins?: RegistryEntry[] } | null;
  if (!body || !Array.isArray(body.plugins)) throw new Error("the marketplace registry sent an unreadable index");
  const origin = originOf(deps.apiBase);
  const installed = deps.installed();
  return {
    registryUrl: origin,
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
    hostVersion: "",
    plugins: body.plugins
      .filter((e) => e && typeof e.id === "string" && e.pricing && typeof e.version === "string")
      .map((e) => registryToMarketEntry(e, origin, installed)),
  };
}

/** One plugin's registry detail, shaped like `plugins.marketplace.get`. */
export async function loadRegistryPlugin(
  deps: RegistryDeps,
  id: string,
): Promise<{ registryUrl: string; hostVersion: string; plugin: MarketEntry & { versions?: unknown[] } }> {
  const raw = (await getJson(deps, `/plugins/${encodeURIComponent(id)}`)) as (RegistryEntry & { versions?: unknown[] }) | null;
  if (!raw || typeof raw.id !== "string") throw new Error("the marketplace registry sent an unreadable plugin");
  const origin = originOf(deps.apiBase);
  const entry = registryToMarketEntry(raw, origin, deps.installed());
  return { registryUrl: origin, hostVersion: "", plugin: { ...entry, versions: Array.isArray(raw.versions) ? raw.versions : [] } };
}

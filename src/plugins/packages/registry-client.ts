/**
 * Marketplace registry client.
 *
 * Speaks the contract in docs/plugins/registry-api.md and nothing else:
 *
 *   GET {registry}/api/marketplace/index.json
 *   GET {registry}/api/marketplace/plugins/:id
 *   GET {registry}/api/marketplace/plugins/:id/download?version=&token=
 *
 * Registry data is untrusted input: every response is size-capped, time
 * limited and shape-checked, entries that don't parse are dropped, and a
 * download is only ever handed on as bytes + sha256 for the installer to
 * verify against the checksum the registry itself published.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { isAllowedPackageUrl, PACKAGE_ID_RE, PACKAGE_LIMITS } from "./format.js";
import { isValidSemver } from "./semver.js";
import { normalizeSha256, PackageError } from "./zip-read.js";
import { toText } from "../../utils/to-text.js";

/** Production site origin (site/lib/layout.mjs SITE.origin). */
export const DEFAULT_PLUGIN_REGISTRY_URL = "https://cloud.infinibotos.com";
export const REGISTRY_URL_ENV = "INFINIBOT_PLUGIN_REGISTRY_URL";
export const REGISTRY_SCHEMA_VERSION = 1;

const INDEX_MAX_BYTES = 5 * 1024 * 1024;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;

export type RegistryPricing = {
  model: "free" | "paid";
  priceCents: number;
  currency: string;
  purchaseUrl: string | null;
  /** Hosted plan ids whose members get a paid plugin without buying it. */
  includedPlans: string[];
};

/** A listing screenshot. Registries send either a bare URL or `{src, caption}`. */
export type RegistryScreenshot = { src: string; caption?: string };

export type RegistryEntry = {
  id: string;
  name: string;
  version: string;
  publisher: { id: string; name: string; verified: boolean };
  firstParty: boolean;
  description: string;
  category: string;
  tags: string[];
  pricing: RegistryPricing;
  downloadUrl: string | null;
  sha256: string;
  sizeBytes: number;
  minHostVersion: string;
  homepageUrl: string | null;
  listing: {
    cover: string | null;
    icon: string | null;
    screenshots: RegistryScreenshot[];
    /** One-line summary for cards ("" when the registry sends none). */
    tagline: string;
  };
  affiliate?: { enabled: boolean };
  /** The registry's own "featured" flag (sorted first in the Marketplace tab). */
  featured: boolean;
  /**
   * "external": the publisher sells and delivers the plugin (pricing.purchaseUrl);
   * the registry hosts no zip, so it can't be installed or updated from here —
   * the buyer imports the zip the seller gives them.
   */
  distribution: "hosted" | "external";
  /**
   * Works on InfiniBot Cloud? (optional; older registries leave it out).
   * "partial": available, with `selfHostOnly` features that need self-hosting.
   */
  cloud?: RegistryCloudListing;
};

export type RegistryCloudListing = {
  availability: "available" | "partial" | "coming-soon" | "self-host-only";
  note?: string;
  selfHostOnly?: Array<{ feature: string; why: string }>;
};

const CLOUD_AVAILABILITY = new Set(["available", "partial", "coming-soon", "self-host-only"]);

function parseCloudListing(raw: unknown): RegistryCloudListing | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.availability !== "string" ||
    !CLOUD_AVAILABILITY.has(raw.availability)
  ) {
    return undefined;
  }
  const note = text(raw.note, 500).trim();
  const features = (Array.isArray(raw.selfHostOnly) ? raw.selfHostOnly : [])
    .filter(isRecord)
    .map((f) => ({ feature: text(f.feature, 80).trim(), why: text(f.why, 300).trim() }))
    .filter((f) => f.feature)
    .slice(0, 12);
  return {
    availability: raw.availability as RegistryCloudListing["availability"],
    ...(note ? { note } : {}),
    ...(features.length ? { selfHostOnly: features } : {}),
  };
}

export type RegistryVersion = {
  version: string;
  releasedAt: string;
  sha256: string;
  sizeBytes: number;
  minHostVersion: string;
  changelog: string;
};

export type RegistryIndex = {
  schemaVersion: 1;
  generatedAt: string;
  plugins: RegistryEntry[];
};

/** What the listing says the plugin asks for (display only: the install review reads the package itself). */
export type RegistryPermissions = {
  network: string[];
  fs: string[];
  secrets: string[];
  channels: string[];
  gated: string[];
  exec: boolean;
  phi: boolean;
  credits: boolean;
};

export type RegistryPluginDetail = RegistryEntry & {
  versions: RegistryVersion[];
  /** Absent when the registry sends no summary. */
  permissions?: RegistryPermissions;
};

export type RegistryFetch = typeof fetch;

export type RegistryClientOptions = {
  registryUrl: string;
  fetchImpl?: RegistryFetch;
  timeoutMs?: number;
  userAgent?: string;
};

/** Config → env → default, normalised (no trailing slash). Throws on a bad URL. */
export function resolveRegistryUrl(
  config?: InfinibotConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    env[REGISTRY_URL_ENV]?.trim() ||
    config?.plugins?.registryUrl?.trim() ||
    DEFAULT_PLUGIN_REGISTRY_URL;
  return normalizeRegistryUrl(raw);
}

export function normalizeRegistryUrl(raw: string): string {
  if (!isAllowedPackageUrl(raw)) {
    throw new PackageError(
      `plugin registry URL must be https (http only for localhost): ${raw}`,
      "network",
    );
  }
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** http(s) URL or null — registry-supplied links are opened in the user's browser. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function resolveAgainst(base: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value.trim(), `${base}/`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `"url"` or `{src, caption?}` → typed, or null when the URL isn't http(s). */
function parseScreenshot(raw: unknown, registryUrl: string): RegistryScreenshot | null {
  const src = resolveAgainst(registryUrl, isRecord(raw) ? raw.src : raw);
  if (!src) return null;
  const caption = isRecord(raw) ? text(raw.caption, 200).trim() : "";
  return caption ? { src, caption } : { src };
}

/** One index entry → typed, or null when it doesn't meet the contract. */
export function parseRegistryEntry(raw: unknown, registryUrl: string): RegistryEntry | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id, 64);
  const version = text(raw.version, 64);
  const sha256 = normalizeSha256(text(raw.sha256, 80));
  // An entry with nothing to download (no downloadUrl, or "external") is kept as a
  // listing only; a hosted entry must carry the checksum the install verifies.
  const external = raw.distribution === "external" || raw.downloadUrl === null;
  if (!PACKAGE_ID_RE.test(id) || !isValidSemver(version) || (!sha256 && !external)) return null;
  const name = text(raw.name, 64) || id;
  const publisher = isRecord(raw.publisher) ? raw.publisher : {};
  const pricingRaw = isRecord(raw.pricing) ? raw.pricing : {};
  const model = pricingRaw.model === "paid" ? "paid" : "free";
  const priceCents =
    typeof pricingRaw.priceCents === "number" && Number.isFinite(pricingRaw.priceCents)
      ? Math.max(0, Math.round(pricingRaw.priceCents))
      : 0;
  const listing = isRecord(raw.listing) ? raw.listing : {};
  const minHost = text(raw.minHostVersion, 64);
  const sizeBytes = typeof raw.sizeBytes === "number" && raw.sizeBytes >= 0 ? raw.sizeBytes : 0;
  const affiliate = isRecord(raw.affiliate)
    ? { enabled: raw.affiliate.enabled === true }
    : undefined;
  return {
    id,
    name,
    version,
    publisher: {
      id: text(publisher.id, 64),
      name: text(publisher.name, 64) || text(publisher.id, 64),
      verified: publisher.verified === true,
    },
    firstParty: raw.firstParty === true,
    description: text(raw.description, 20_000),
    category: text(raw.category, 32) || "apps",
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .filter((t): t is string => typeof t === "string")
      .slice(0, 12)
      .map((t) => t.slice(0, 32)),
    pricing: {
      model,
      priceCents,
      currency: (text(pricingRaw.currency, 8) || "USD").toUpperCase(),
      purchaseUrl: webUrl(pricingRaw.purchaseUrl),
      includedPlans: (Array.isArray(pricingRaw.includedPlans) ? pricingRaw.includedPlans : [])
        .filter((p): p is string => typeof p === "string" && Boolean(p.trim()))
        .slice(0, 16)
        .map((p) => p.trim().slice(0, 64)),
    },
    downloadUrl: external ? null : resolveAgainst(registryUrl, raw.downloadUrl),
    sha256: external ? "" : (sha256 ?? ""),
    sizeBytes: external ? 0 : sizeBytes,
    minHostVersion: isValidSemver(minHost) ? minHost : "0.0.0",
    homepageUrl: webUrl(raw.homepageUrl),
    listing: {
      cover: resolveAgainst(registryUrl, listing.cover),
      icon: resolveAgainst(registryUrl, listing.icon),
      screenshots: (Array.isArray(listing.screenshots) ? listing.screenshots : [])
        .map((s) => parseScreenshot(s, registryUrl))
        .filter((s): s is RegistryScreenshot => Boolean(s))
        .slice(0, 8),
      tagline: text(listing.tagline, 160).trim(),
    },
    ...(affiliate ? { affiliate } : {}),
    featured: raw.featured === true,
    distribution: external ? "external" : "hosted",
    ...(parseCloudListing(raw.cloud) ? { cloud: parseCloudListing(raw.cloud) } : {}),
  };
}

function parseVersion(raw: unknown): RegistryVersion | null {
  if (!isRecord(raw)) return null;
  const version = text(raw.version, 64);
  const sha256 = normalizeSha256(text(raw.sha256, 80));
  if (!isValidSemver(version) || !sha256) return null;
  const minHost = text(raw.minHostVersion, 64);
  return {
    version,
    releasedAt: text(raw.releasedAt, 64),
    sha256,
    sizeBytes: typeof raw.sizeBytes === "number" && raw.sizeBytes >= 0 ? raw.sizeBytes : 0,
    minHostVersion: isValidSemver(minHost) ? minHost : "0.0.0",
    changelog: text(raw.changelog, 20_000),
  };
}

function parsePermissions(raw: unknown): RegistryPermissions | undefined {
  if (!isRecord(raw)) return undefined;
  const strings = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
      .slice(0, 24)
      .map((x) => x.trim().slice(0, 200));
  return {
    network: strings(raw.network),
    fs: strings(raw.fs),
    secrets: strings(raw.secrets),
    channels: strings(raw.channels),
    gated: strings(raw.gated),
    exec: raw.exec === true,
    phi: raw.phi === true,
    credits: raw.credits === true,
  };
}

export class PaymentRequiredError extends PackageError {
  constructor(
    readonly pluginId: string,
    readonly purchaseUrl: string | null,
  ) {
    super(
      purchaseUrl
        ? `${pluginId} is a paid plugin: buy it, then install it from your purchase page`
        : `${pluginId} is a paid plugin: buy it first`,
      "payment",
    );
    this.name = "PaymentRequiredError";
  }
}

export type DownloadedPackage = {
  buffer: Buffer;
  /** Final URL the bytes came from (after redirects). */
  url: string;
};

export function createRegistryClient(opts: RegistryClientOptions) {
  const registryUrl = normalizeRegistryUrl(opts.registryUrl);
  const fetchImpl: RegistryFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    "user-agent": opts.userAgent ?? "infinibot-plugins",
    accept: "application/json",
  };

  async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PackageError(`registry response is too large (${declared} bytes)`, "too-large");
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PackageError("registry response is too large", "too-large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async function getJson(pathname: string, maxBytes: number): Promise<unknown> {
    const url = `${registryUrl}${pathname}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new PackageError(
        `could not reach the plugin registry (${registryUrl}): ${String(err)}`,
        "network",
      );
    }
    if (res.status === 404)
      throw new PackageError(`not found in the registry: ${pathname}`, "network");
    if (!res.ok)
      throw new PackageError(`registry returned HTTP ${res.status} for ${pathname}`, "network");
    const body = await readCapped(res, maxBytes);
    try {
      return JSON.parse(body.toString("utf-8")) as unknown;
    } catch {
      throw new PackageError(`registry returned invalid JSON for ${pathname}`, "network");
    }
  }

  return {
    registryUrl,

    async index(): Promise<RegistryIndex> {
      const raw = await getJson("/api/marketplace/index.json", INDEX_MAX_BYTES);
      if (
        !isRecord(raw) ||
        raw.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
        !Array.isArray(raw.plugins)
      ) {
        throw new PackageError(
          `the registry speaks an unsupported schema (expected schemaVersion ${REGISTRY_SCHEMA_VERSION})`,
          "network",
        );
      }
      const seen = new Set<string>();
      const plugins: RegistryEntry[] = [];
      for (const item of raw.plugins) {
        const entry = parseRegistryEntry(item, registryUrl);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        plugins.push(entry);
      }
      return { schemaVersion: 1, generatedAt: text(raw.generatedAt, 64), plugins };
    },

    async plugin(id: string): Promise<RegistryPluginDetail> {
      if (!PACKAGE_ID_RE.test(id)) throw new PackageError(`invalid plugin id "${id}"`, "manifest");
      const raw = await getJson(
        `/api/marketplace/plugins/${encodeURIComponent(id)}`,
        DETAIL_MAX_BYTES,
      );
      const entry = parseRegistryEntry(raw, registryUrl);
      if (!entry || entry.id !== id) {
        throw new PackageError(`the registry returned an invalid entry for "${id}"`, "network");
      }
      const versions = (
        Array.isArray((raw as { versions?: unknown }).versions)
          ? (raw as { versions: unknown[] }).versions
          : []
      )
        .map(parseVersion)
        .filter((v): v is RegistryVersion => Boolean(v));
      const permissions = parsePermissions((raw as { permissions?: unknown }).permissions);
      return { ...entry, versions, ...(permissions ? { permissions } : {}) };
    },

    /**
     * Download a package. Follows up to 5 redirects by hand so every hop is
     * checked (https, or http on loopback) and an entitlement token is only
     * ever sent to the registry itself, never to the redirect target.
     */
    async download(
      id: string,
      params: { version?: string; token?: string } = {},
    ): Promise<DownloadedPackage> {
      if (!PACKAGE_ID_RE.test(id)) throw new PackageError(`invalid plugin id "${id}"`, "manifest");
      const first = new URL(
        `${registryUrl}/api/marketplace/plugins/${encodeURIComponent(id)}/download`,
      );
      first.searchParams.set("version", params.version ?? "latest");
      if (params.token) first.searchParams.set("token", params.token);
      return fetchPackage(first.toString(), {
        fetchImpl,
        pluginId: id,
        userAgent: headers["user-agent"],
      });
    },
  };
}

export type RegistryClient = ReturnType<typeof createRegistryClient>;

/** Download a package zip from any allowed URL (URL installs and registry downloads). */
export async function fetchPackage(
  startUrl: string,
  opts: {
    fetchImpl?: RegistryFetch;
    pluginId?: string;
    userAgent?: string;
    maxBytes?: number;
  } = {},
): Promise<DownloadedPackage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? PACKAGE_LIMITS.maxZipBytes;
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedPackageUrl(url)) {
      throw new PackageError(
        `refusing to download from ${safeUrlForMessage(url)} (https only)`,
        "network",
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: {
          "user-agent": opts.userAgent ?? "infinibot-plugins",
          accept: "application/zip, application/octet-stream, application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PackageError(`download failed: ${String(err)}`, "network");
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new PackageError("download redirect without a location", "network");
      url = new URL(loc, url).toString();
      continue;
    }
    if (res.status === 402) {
      let purchaseUrl: string | null = null;
      try {
        const body = (await res.json()) as { purchaseUrl?: unknown };
        purchaseUrl = webUrl(body.purchaseUrl);
      } catch {
        /* no body */
      }
      throw new PaymentRequiredError(opts.pluginId ?? "this plugin", purchaseUrl);
    }
    if (res.status === 404 || res.status === 409) {
      let error = "";
      try {
        error = toText(((await res.json()) as { error?: unknown }).error ?? "");
      } catch {
        /* no body */
      }
      if (res.status === 404 && error !== "external_distribution") {
        throw new PackageError("package not found (404)", "network");
      }
      throw new PackageError(
        `${opts.pluginId ?? "this plugin"} is not hosted by the registry: the publisher delivers it, then import the zip`,
        "network",
      );
    }
    if (!res.ok) throw new PackageError(`download failed with HTTP ${res.status}`, "network");
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PackageError(`package is ${declared} bytes; the limit is ${maxBytes}`, "too-large");
    }
    if (!res.body) throw new PackageError("download returned no data", "network");
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PackageError(`package is larger than ${maxBytes} bytes`, "too-large");
      }
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), url: stripQuerySecrets(url) };
  }
  throw new PackageError("too many redirects while downloading the package", "network");
}

/** Never echo a license key (or any query string) back in errors or records. */
function stripQuerySecrets(raw: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.delete("license");
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw;
  }
}

function safeUrlForMessage(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "that URL";
  }
}

export function formatPrice(pricing: RegistryPricing): string {
  if (pricing.model === "free" || pricing.priceCents <= 0) return "Free";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: pricing.currency }).format(
      pricing.priceCents / 100,
    );
  } catch {
    return `${(pricing.priceCents / 100).toFixed(2)} ${pricing.currency}`;
  }
}

/**
 * Plugin store listing — the optional `listing` block of infinibot.plugin.json
 * (v1 and v2 manifests alike). It only feeds Setup › Plugins (cards, detail
 * page, gallery), so it is parsed LENIENTLY: a malformed field is dropped with
 * a warning and never stops the plugin from loading. That keeps the block
 * backward compatible — plugins without it look exactly as before.
 *
 * ```jsonc
 * "listing": {
 *   "tagline": "One line under the name",
 *   "description": "Long **markdown** description",
 *   "category": "apps",                 // apps | channels | integrations | developer | <slug>
 *   "tags": ["voice", "agents"],
 *   "cover": "assets/cover.svg",        // 16:9, inside the plugin folder
 *   "icon": "assets/icon.svg",          // square
 *   "screenshots": [{ "src": "assets/shot-1.webp", "caption": "…" }],
 *   "publisher": { "name": "InfiniBot", "url": "https://…" },
 *   "links": { "docs": "https://…", "support": "https://…", "source": "https://…" }
 * }
 * ```
 *
 * Images are paths inside the plugin folder (served by the authenticated
 * `/api/plugin-assets/<id>/<path>` route, declared files only) or small
 * inline `data:image/…;base64,` URLs. Design: docs/plugins/PLUGINS-PAGE-CONTROL.md.
 */

export type PluginListingImage = { src: string; caption?: string };

export type PluginListing = {
  tagline?: string;
  description?: string;
  category?: string;
  tags: string[];
  cover?: string;
  icon?: string;
  screenshots: PluginListingImage[];
  publisher?: { name: string; url?: string };
  links: { docs?: string; support?: string; source?: string };
};

/** Categories the Plugins page groups by; any other slug is shown as-is. */
export const LISTING_CATEGORIES = ["apps", "channels", "integrations", "developer"] as const;

export const LISTING_LIMITS = {
  tagline: 140,
  description: 20_000,
  tags: 12,
  tag: 32,
  screenshots: 8,
  caption: 200,
  /** Decoded bytes of an inline data: image. */
  dataUrlBytes: 256 * 1024,
} as const;

export const LISTING_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const DATA_URL_RE = /^data:image\/(png|webp|jpeg|gif|avif|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t.slice(0, max) : undefined;
}

/**
 * A plugin-relative asset path that can't escape the plugin folder: relative,
 * forward slashes, no `..`/`.` segments, no scheme/drive, no NUL or
 * backslash, and an image extension. Exported for the HTTP route + tests.
 */
export function isSafeListingAssetPath(p: string): boolean {
  if (!p || p.length > 256) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.includes(":")) return false;
  if (/%2e|%2f|%5c/i.test(p)) return false;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return false;
  const dot = p.lastIndexOf(".");
  return dot > 0 && Object.hasOwn(LISTING_IMAGE_EXTENSIONS, p.slice(dot).toLowerCase());
}

/** `data:image/*;base64,` under the size cap. */
export function isSafeListingDataUrl(p: string): boolean {
  const m = DATA_URL_RE.exec(p);
  if (!m) return false;
  const b64 = m[2]!.replace(/\s+/g, "");
  return Math.floor((b64.length * 3) / 4) <= LISTING_LIMITS.dataUrlBytes;
}

function image(value: unknown, field: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  const v = typeof value === "string" ? value.trim() : "";
  if (v && (isSafeListingAssetPath(v) || isSafeListingDataUrl(v))) return v;
  warnings.push(
    `listing.${field}: must be an image path inside the plugin (png/webp/jpg/gif/avif/svg, no "..") or a data:image URL ≤ 256 KB`,
  );
  return undefined;
}

function link(value: unknown, field: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  const v = typeof value === "string" ? value.trim() : "";
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
  } catch {
    /* fall through */
  }
  warnings.push(`listing.${field}: must be an http(s) URL`);
  return undefined;
}

/**
 * Parse a manifest's `listing` block. Never fails: returns what is valid plus
 * one warning per dropped field. `undefined` input → no listing, no warnings.
 */
export function parseListing(raw: unknown): { listing?: PluginListing; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { warnings };
  if (!isRecord(raw)) return { warnings: ["listing: must be an object"] };

  let category: string | undefined;
  if (raw.category !== undefined) {
    const c = typeof raw.category === "string" ? raw.category.trim().toLowerCase() : "";
    if (SLUG_RE.test(c)) category = c;
    else warnings.push("listing.category: must be a lowercase slug (e.g. apps, channels)");
  }

  const tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) warnings.push("listing.tags: must be an array of strings");
    else
      for (const t of raw.tags) {
        const tag =
          typeof t === "string" ? t.trim().toLowerCase().slice(0, LISTING_LIMITS.tag) : "";
        if (tag && !tags.includes(tag) && tags.length < LISTING_LIMITS.tags) tags.push(tag);
      }
  }

  const screenshots: PluginListingImage[] = [];
  if (raw.screenshots !== undefined) {
    if (!Array.isArray(raw.screenshots))
      warnings.push("listing.screenshots: must be an array of { src, caption }");
    else
      raw.screenshots.slice(0, LISTING_LIMITS.screenshots).forEach((s, i) => {
        const src = image(isRecord(s) ? s.src : s, `screenshots[${i}].src`, warnings);
        if (src)
          screenshots.push({
            src,
            caption: isRecord(s) ? text(s.caption, LISTING_LIMITS.caption) : undefined,
          });
      });
  }

  let publisher: PluginListing["publisher"];
  if (raw.publisher !== undefined) {
    const name = isRecord(raw.publisher) ? text(raw.publisher.name, 80) : text(raw.publisher, 80);
    if (!name) warnings.push("listing.publisher: needs a name");
    else
      publisher = {
        name,
        url: isRecord(raw.publisher)
          ? link(raw.publisher.url, "publisher.url", warnings)
          : undefined,
      };
  }

  const links: PluginListing["links"] = {};
  if (raw.links !== undefined) {
    if (!isRecord(raw.links)) warnings.push("listing.links: must be an object");
    else
      for (const k of ["docs", "support", "source"] as const) {
        const v = link(raw.links[k], `links.${k}`, warnings);
        if (v) links[k] = v;
      }
  }

  return {
    listing: {
      tagline: text(raw.tagline, LISTING_LIMITS.tagline),
      description: text(raw.description, LISTING_LIMITS.description),
      category,
      tags,
      cover: image(raw.cover, "cover", warnings),
      icon: image(raw.icon, "icon", warnings),
      screenshots,
      publisher,
      links,
    },
    warnings,
  };
}

/** Every plugin-relative image path the listing declares (the route's allowlist). */
export function listingAssetPaths(listing: PluginListing | undefined): string[] {
  if (!listing) return [];
  return [listing.cover, listing.icon, ...listing.screenshots.map((s) => s.src)].filter(
    (p): p is string => Boolean(p && isSafeListingAssetPath(p)),
  );
}

export const PLUGIN_ASSET_ROUTE_PREFIX = "/api/plugin-assets/";

/** Browser URL for a listing image: data URLs pass through, paths go via the asset route. */
export function listingAssetUrl(pluginId: string, src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("data:")) return src;
  return `${PLUGIN_ASSET_ROUTE_PREFIX}${encodeURIComponent(pluginId)}/${src
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** The listing as the UI sees it: image paths turned into URLs. */
export function resolveListingForUi(pluginId: string, listing: PluginListing | undefined) {
  if (!listing) return undefined;
  return {
    ...listing,
    cover: listingAssetUrl(pluginId, listing.cover),
    icon: listingAssetUrl(pluginId, listing.icon),
    screenshots: listing.screenshots.map((s) => ({
      ...s,
      src: listingAssetUrl(pluginId, s.src) ?? s.src,
    })),
  };
}

/**
 * Store category for a plugin: the listing's own, else inferred from what it
 * registers (channels → channels, model providers / memory → integrations,
 * first-party pages → apps, everything else → developer).
 */
export function derivePluginCategory(p: {
  listing?: Pick<PluginListing, "category">;
  channelIds?: string[];
  channels?: string[];
  providers?: string[];
  providerIds?: string[];
  kind?: string;
  origin?: string;
  pages?: number;
}): string {
  if (p.listing?.category) return p.listing.category;
  if ((p.channels?.length ?? 0) > 0 || (p.channelIds?.length ?? 0) > 0) return "channels";
  if ((p.providers?.length ?? 0) > 0 || (p.providerIds?.length ?? 0) > 0 || p.kind === "memory")
    return "integrations";
  if ((p.pages ?? 0) > 0) return "apps";
  return "developer";
}

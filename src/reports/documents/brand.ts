/**
 * Branding resolution — `agency_profiles` layered over a report {@link Theme}.
 *
 * The report system already owns the look (themes/black-gold.ts). An agency's
 * own brand is a *layer* on top of it, not a second brand mechanism: we start
 * from the theme tokens and let `branding_json` override individual colours,
 * plus pull the contact block / logo / tagline from the profile columns.
 *
 * Two rules make this safe:
 *  - every colour goes through `safeColor`, so a hostile or malformed value in
 *    `branding_json` can never escape the CSS declaration it sits in;
 *  - only `data:` logos are embedded, because a document must render with no
 *    network access (a remote `<img>` would silently produce a broken box in
 *    the PDF, or hang the render waiting on `networkidle0`).
 */

import type { Theme } from "../types.js";
import { safeColor } from "./html.js";
import type { DocumentBrand, DocumentBrandColors } from "./types.js";

/**
 * The subset of an `agency_profiles` row this module needs. Structurally
 * satisfied by `AgencyProfile` from `agency-operations/types.ts`; declared
 * locally so the report worker never imports the agency module.
 */
export interface AgencyBrandSource {
  name?: string | null;
  logo?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  tagline?: string | null;
  branding?: Record<string, unknown> | null;
  socialMedia?: Record<string, unknown> | null;
}

/** First non-empty string among the given keys of an untyped object. */
function pick(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function clean(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

/**
 * Split a free-form address into display lines. Newlines win; otherwise commas
 * are used, which is how addresses arrive from the legacy `business.json`
 * import. Capped so a pathological value can't push the header off the page.
 */
export function splitAddress(address: string | null | undefined): string[] {
  const raw = typeof address === "string" ? address.trim() : "";
  if (!raw) return [];
  const parts = (raw.includes("\n") ? raw.split(/\r?\n/) : raw.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, 5);
}

/** Up to two initials from the agency name, for the no-logo fallback mark. */
export function monogramFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "AG";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Only self-contained images are embedded — see the module note on offline rendering. */
export function embeddableLogo(logo: string | null | undefined): string | null {
  const raw = typeof logo === "string" ? logo.trim() : "";
  if (!raw) return null;
  if (!/^data:image\/(png|jpe?g|gif|svg\+xml|webp);base64,/i.test(raw)) return null;
  if (!/^[\w+/=:;,.-]+$/.test(raw.replace(/\s+/g, ""))) return null;
  // A multi-megabyte logo bloats every PDF; refuse rather than degrade silently.
  if (raw.length > 512_000) return null;
  return raw.replace(/\s+/g, "");
}

/** Normalise a website for display (strip scheme/trailing slash) — link uses the raw value. */
export function displayWebsite(website: string | null | undefined): string | null {
  const raw = clean(website);
  if (!raw) return null;
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "") || null;
}

function resolveColors(
  theme: Theme,
  branding: Record<string, unknown> | null | undefined,
): DocumentBrandColors {
  const t = theme.tokens;
  const accent = safeColor(
    pick(branding, ["accent", "accentColor", "primary", "primaryColor", "brandColor"]),
    t.accent,
  );
  return {
    bg: safeColor(pick(branding, ["bg", "background", "backgroundColor", "pageColor"]), t.bg),
    surface: safeColor(pick(branding, ["surface", "surfaceColor", "panelColor"]), t.surface),
    surfaceAlt: safeColor(pick(branding, ["surfaceAlt", "surfaceAltColor"]), t.surfaceAlt),
    border: safeColor(pick(branding, ["border", "borderColor"]), t.border),
    text: safeColor(pick(branding, ["text", "textColor", "bodyColor"]), t.text),
    textMuted: safeColor(
      pick(branding, ["textMuted", "mutedColor", "secondaryTextColor"]),
      t.textMuted,
    ),
    accent,
    accentStrong: safeColor(
      pick(branding, ["accentStrong", "accentStrongColor", "secondary", "secondaryColor"]),
      // When only a primary was supplied, the deep accent should follow it
      // rather than clashing with the theme's gold.
      pick(branding, ["accent", "accentColor", "primary", "primaryColor", "brandColor"])
        ? accent
        : t.accentStrong,
    ),
    fontHeading: t.fontHeading,
    fontBody: t.fontBody,
  };
}

/**
 * Build render-ready branding. Every field has a fallback, so a profile that is
 * entirely empty (a fresh install) still produces a presentable document with
 * the theme's own identity.
 */
export function resolveDocumentBrand(
  source: AgencyBrandSource | null | undefined,
  theme: Theme,
  fallbackName = "Your Agency",
): DocumentBrand {
  const branding = source?.branding ?? null;
  const name =
    clean(source?.name) ??
    clean(pick(branding, ["name", "agencyName", "companyName"])) ??
    fallbackName;
  return {
    name,
    tagline: clean(source?.tagline) ?? clean(pick(branding, ["tagline", "slogan"])),
    logoDataUri:
      embeddableLogo(source?.logo) ?? embeddableLogo(pick(branding, ["logo", "logoDataUri"])),
    monogram: monogramFor(name),
    email: clean(source?.email),
    phone: clean(source?.phone),
    website: displayWebsite(source?.website),
    addressLines: splitAddress(source?.address),
    colors: resolveColors(theme, branding),
    footerNote: clean(pick(branding, ["footerNote", "footer", "legalFooter", "registration"])),
  };
}

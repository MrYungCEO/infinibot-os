/**
 * Per-business branding helpers.
 *
 * Reads the same `state/business.json` written by `gateway/server-methods/business.ts`,
 * and projects a business's brand identity into:
 *   - landing-page settings (colors / fonts / titles / favicon / og-image / logo block)
 *   - agent context fragments (a markdown system-prompt snippet describing the business)
 *
 * No external deps — pure read + project.
 */

import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";

// Mirror of relevant slice of the BusinessProfile shape persisted by business.ts.
export interface BusinessBrandingPayload {
  id: string;
  name: string;
  tagline?: string | null;
  logo?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  socialMedia?: Record<string, unknown> | null;
  branding?: {
    colors?: { primary?: string; secondary?: string; accent?: string; background?: string; text?: string };
    fonts?: { heading?: string; body?: string };
    assets?: { coverImage?: string; favicon?: string; ogImage?: string };
    voice?: { tone?: string; audience?: string; do?: string[]; dont?: string[] };
  } | null;
}

interface RawBusinessFile {
  businesses?: BusinessBrandingPayload[];
  activeBusinessId?: string | null;
}

function statePath(): string {
  return path.join(CONFIG_DIR, "state", "business.json");
}

function loadAll(): { businesses: BusinessBrandingPayload[]; activeId: string | null } {
  try {
    const raw = fs.readFileSync(statePath(), "utf-8");
    const parsed = JSON.parse(raw) as RawBusinessFile;
    return {
      businesses: Array.isArray(parsed.businesses) ? parsed.businesses : [],
      activeId: parsed.activeBusinessId ?? null,
    };
  } catch {
    return { businesses: [], activeId: null };
  }
}

/**
 * Look up a business by id. Falls back to the active business when id is omitted
 * or doesn't match. Returns `null` if no businesses are configured.
 */
export function getBusinessBranding(businessId?: string): BusinessBrandingPayload | null {
  const { businesses, activeId } = loadAll();
  if (businesses.length === 0) return null;
  if (businessId) {
    const exact = businesses.find((b) => b.id === businessId);
    if (exact) return exact;
    // Try matching on name (case-insensitive) — useful when callers pass a slug.
    const slug = businesses.find((b) => b.name && b.name.toLowerCase() === businessId.toLowerCase());
    if (slug) return slug;
  }
  if (activeId) {
    const active = businesses.find((b) => b.id === activeId);
    if (active) return active;
  }
  return businesses[0] ?? null;
}

export function listBusinessBrandingSummaries(): Array<{ id: string; name: string; tagline?: string | null; logo?: string | null }> {
  const { businesses } = loadAll();
  return businesses.map((b) => ({ id: b.id, name: b.name, tagline: b.tagline, logo: b.logo }));
}

// ── Project to landing-page settings ────────────────────────

export interface PageSettingsBrandingProjection {
  title?: string;
  description?: string;
  ogImage?: string;
  favicon?: string;
  colors?: { primary?: string; secondary?: string; accent?: string; background?: string; text?: string };
  fonts?: { heading?: string; body?: string };
  /** Suggested header/footer block prefilled with business identity. */
  headerSuggestion?: { logo?: string; tagline?: string; siteName?: string };
  footerSuggestion?: { tagline?: string; copyright?: string; socialLinks?: Record<string, unknown> };
}

export function projectBrandingToPageSettings(b: BusinessBrandingPayload): PageSettingsBrandingProjection {
  const colors = b.branding?.colors ?? {};
  const fonts = b.branding?.fonts ?? {};
  const assets = b.branding?.assets ?? {};
  const year = new Date().getFullYear();
  return {
    title: b.tagline ? `${b.name} — ${b.tagline}` : b.name,
    description: b.tagline || undefined,
    ogImage: assets.ogImage || b.logo || undefined,
    favicon: assets.favicon || b.logo || undefined,
    colors: {
      primary: colors.primary,
      secondary: colors.secondary,
      accent: colors.accent,
      background: colors.background,
      text: colors.text,
    },
    fonts: {
      heading: fonts.heading,
      body: fonts.body,
    },
    headerSuggestion: {
      logo: b.logo || undefined,
      tagline: b.tagline || undefined,
      siteName: b.name,
    },
    footerSuggestion: {
      tagline: b.tagline || undefined,
      copyright: `© ${year} ${b.name}. All rights reserved.`,
      socialLinks: b.socialMedia || undefined,
    },
  };
}

// ── Agent context fragment ──────────────────────────────────

/**
 * Render a markdown system-prompt fragment that primes an agent with the
 * business's identity, voice, and contact info. Safe to inject into any
 * agent system prompt or attach to a chat turn as additional context.
 */
export function formatBusinessContextPrompt(businessId?: string): string | null {
  const b = getBusinessBranding(businessId);
  if (!b) return null;
  const lines: string[] = [];
  lines.push(`# Business context: ${b.name}`);
  if (b.tagline) lines.push(`_${b.tagline}_`);
  if (b.industry) lines.push(`- Industry: ${b.industry}`);
  if (b.website) lines.push(`- Website: ${b.website}`);
  if (b.email) lines.push(`- Email: ${b.email}`);
  if (b.phone) lines.push(`- Phone: ${b.phone}`);
  if (b.address) lines.push(`- Address: ${b.address}`);
  if (b.socialMedia && typeof b.socialMedia === "object") {
    const social = Object.entries(b.socialMedia).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => `${k}=${v}`);
    if (social.length > 0) lines.push(`- Social: ${social.join(", ")}`);
  }
  const branding = b.branding;
  if (branding?.colors) {
    const c = branding.colors;
    const parts = [c.primary && `primary=${c.primary}`, c.accent && `accent=${c.accent}`, c.background && `background=${c.background}`, c.text && `text=${c.text}`].filter(Boolean);
    if (parts.length > 0) lines.push(`- Brand colors: ${parts.join(", ")}`);
  }
  if (branding?.fonts) {
    const f = branding.fonts;
    const parts = [f.heading && `heading="${f.heading}"`, f.body && `body="${f.body}"`].filter(Boolean);
    if (parts.length > 0) lines.push(`- Brand fonts: ${parts.join(", ")}`);
  }
  if (branding?.voice) {
    if (branding.voice.tone) lines.push(`- Voice/tone: ${branding.voice.tone}`);
    if (branding.voice.audience) lines.push(`- Audience: ${branding.voice.audience}`);
    if (branding.voice.do && branding.voice.do.length > 0) lines.push(`- DO: ${branding.voice.do.join("; ")}`);
    if (branding.voice.dont && branding.voice.dont.length > 0) lines.push(`- DON'T: ${branding.voice.dont.join("; ")}`);
  }
  lines.push("");
  lines.push("When generating copy, marketing assets, emails, replies, or website content for this business, apply the colors, fonts, voice, and tone consistently. When a brand asset is needed, prefer the listed assets above.");
  return lines.join("\n");
}

// ── CSS variable string ─────────────────────────────────────

/** Build a `:root { --... }` CSS rule string from the branding tokens — useful for embedded preview. */
export function buildBrandingCssVars(b: BusinessBrandingPayload): string {
  const c = b.branding?.colors ?? {};
  const f = b.branding?.fonts ?? {};
  const out: string[] = [];
  if (c.primary)    out.push(`--g-primary: ${c.primary};`);
  if (c.accent)     out.push(`--g-accent: ${c.accent};`);
  if (c.background) out.push(`--g-bg: ${c.background};`);
  if (c.text)       out.push(`--g-fg: ${c.text};`);
  if (f.heading)    out.push(`--lp-font-heading: ${f.heading};`);
  if (f.body)       out.push(`--g-fontFamily: ${f.body};`);
  return out.length === 0 ? "" : `:root { ${out.join(" ")} }`;
}

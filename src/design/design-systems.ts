/**
 * Design page — design system registry.
 *
 * A "design system" is a single `DESIGN.md` file following the 9-section
 * schema from VoltAgent/awesome-design-md (color · typography · spacing ·
 * layout · components · motion · voice · brand · anti-patterns).
 *
 * Lookup order (later overrides):
 *   1. Bundled at `src/design/seed-systems/<id>.md`.
 *   2. User at `${stateDir}/design-systems/<id>.md`.
 *
 * Tokens used for in-UI preview chrome are scraped from the doc body
 * via simple regex — `primary: #hex`, `accent: #hex`, `font-family: ...`.
 * The agent reads the full DESIGN.md when actually generating; the
 * picker only needs the lightweight tokens for swatch rendering.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

import type { DesignSystem } from "./types.js";
import { splitFrontmatter } from "./skills-registry.js";

let _cache: { systems: DesignSystem[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function listDesignSystems(stateDir: string): DesignSystem[] {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) return _cache.systems;
  const out: DesignSystem[] = [];
  const seedDir = resolveSeedDir();
  if (seedDir && existsSync(seedDir)) collectFrom(seedDir, out);
  const userDir = join(stateDir, "design-systems");
  if (existsSync(userDir)) collectFrom(userDir, out, /* allowOverride */ true);
  out.sort((a, b) => a.name.localeCompare(b.name));
  _cache = { systems: out, loadedAt: Date.now() };
  return out;
}

export function getDesignSystem(stateDir: string, id: string): DesignSystem | null {
  return listDesignSystems(stateDir).find((s) => s.id === id) ?? null;
}

export function invalidateSystemCache(): void {
  _cache = null;
}

function resolveSeedDir(): string | null {
  try {
    const here =
      typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
    return join(here, "seed-systems");
  } catch {
    return null;
  }
}

function collectFrom(rootDir: string, out: DesignSystem[], allowOverride = false): void {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(rootDir, entry);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let system: DesignSystem;
    try {
      system = parseSystem(filePath, entry);
    } catch (err) {
      console.warn(`[design-systems] failed to parse ${filePath}:`, err);
      continue;
    }
    const idx = out.findIndex((s) => s.id === system.id);
    if (idx >= 0) {
      if (allowOverride) out[idx] = system;
      continue;
    }
    out.push(system);
  }
}

function parseSystem(filePath: string, basename: string): DesignSystem {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const id = basename.replace(/\.md$/i, "").toLowerCase();
  const name = (frontmatter.name as string | undefined) || body.match(/^#\s+(.+)$/m)?.[1] || id;
  const description =
    (frontmatter.description as string | undefined) ??
    body
      .split("\n")
      .slice(1)
      .find((l) => l.trim() && !l.trim().startsWith("#"))
      ?.slice(0, 220) ??
    "";
  return {
    id,
    name,
    description,
    rootPath: resolve(filePath),
    tokens: scrapeTokens(body),
  };
}

function scrapeTokens(body: string): DesignSystem["tokens"] {
  const t: DesignSystem["tokens"] = {};
  // primary / accent: any hex color near the words "primary"/"accent".
  const primary = body.match(/primary[^\n]*?(#[0-9a-fA-F]{3,8})/i);
  if (primary) t.primary = primary[1];
  const accent = body.match(/accent[^\n]*?(#[0-9a-fA-F]{3,8})/i);
  if (accent) t.accent = accent[1];
  const bg = body.match(/(?:background|surface|bg)[^\n]*?(#[0-9a-fA-F]{3,8})/i);
  if (bg) t.background = bg[1];
  // font-family: take the first non-empty line after a "Font" / "Typography" header.
  const fontHeader = body.match(
    /(?:Typography|Font|Typeface)\s*\n[\s\S]{0,400}?([\w\s-]+(?:,\s*[\w\s-]+)*)/i,
  );
  if (fontHeader) {
    const candidate = fontHeader[1]
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#") && !s.startsWith("-"));
    if (candidate) t.fontFamily = candidate;
  }
  return t;
}

import fs from "node:fs";
import path from "node:path";

import type { PluginConfigUiHint, PluginKind } from "./types.js";
import { parseManifestAccess, type PluginAccessPolicy } from "./entitlements/access.js";
import { parseListing, type PluginListing } from "./listing.js";
import { parseManifestV2, type PluginManifestV2Fields } from "./manifest-v2.js";
import { parseUpdateBlock, type PluginUpdateBlock } from "./packages/format.js";
import { isValidSemver } from "./packages/semver.js";

export const PLUGIN_MANIFEST_FILENAME = "infinibot.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;

/** A plugin-contributed page/panel the control-ui can load at runtime. `entry`
 *  is an HTTP path the plugin itself serves (via registerHttpRoute) — a JS
 *  module exporting a custom-element registration the frontend dynamically
 *  imports. Not a local file path: the browser fetches it over the gateway's
 *  HTTP server, same as any other asset. */
export type PluginUiContribution = {
  navLabel: string;
  navIcon?: string;
  entry: string;
};

export type PluginManifest = {
  id: string;
  configSchema: Record<string, unknown>;
  kind?: PluginKind;
  channels?: string[];
  providers?: string[];
  skills?: string[];
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  ui?: PluginUiContribution;
  /** Present only for `"manifestVersion": 2` manifests (see manifest-v2.ts). */
  v2?: PluginManifestV2Fields;
  /** Optional store listing (any manifest version; lenient, see listing.ts). */
  listing?: PluginListing;
  /** Fields of `listing` that were dropped as malformed. */
  listingWarnings?: string[];
  /** Optional `access` block (restrict-only): `{ desktop?: true, purchase?: { priceCents } }`. */
  access?: PluginAccessPolicy;
  /** Oldest InfiniBot (semver) that runs this plugin; the loader gates on it. */
  minHostVersion?: string;
  /** Update settings (docs/plugins/updates.md). */
  update?: PluginUpdateBlock;
};

export type PluginManifestLoadResult =
  | { ok: true; manifest: PluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolvePluginManifestPath(rootDir: string): string {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const candidate = path.join(rootDir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}

export function loadPluginManifest(rootDir: string): PluginManifestLoadResult {
  const manifestPath = resolvePluginManifestPath(rootDir);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "plugin manifest must be an object", manifestPath };
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return { ok: false, error: "plugin manifest requires id", manifestPath };
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return { ok: false, error: "plugin manifest requires configSchema", manifestPath };
  }

  const kind = typeof raw.kind === "string" ? (raw.kind as PluginKind) : undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
  const description = typeof raw.description === "string" ? raw.description.trim() : undefined;
  const version = typeof raw.version === "string" ? raw.version.trim() : undefined;
  const channels = normalizeStringList(raw.channels);
  const providers = normalizeStringList(raw.providers);
  const skills = normalizeStringList(raw.skills);

  let uiHints: Record<string, PluginConfigUiHint> | undefined;
  if (isRecord(raw.uiHints)) {
    uiHints = raw.uiHints as Record<string, PluginConfigUiHint>;
  }

  let ui: PluginUiContribution | undefined;
  if (isRecord(raw.ui)) {
    const navLabel = typeof raw.ui.navLabel === "string" ? raw.ui.navLabel.trim() : "";
    const entry = typeof raw.ui.entry === "string" ? raw.ui.entry.trim() : "";
    const navIcon = typeof raw.ui.navIcon === "string" ? raw.ui.navIcon.trim() : undefined;
    if (navLabel && entry) ui = { navLabel, entry, navIcon };
  }

  let v2: PluginManifestV2Fields | undefined;
  if (raw.manifestVersion !== undefined) {
    if (raw.manifestVersion !== 2) {
      return {
        ok: false,
        error: `unsupported manifestVersion: ${String(raw.manifestVersion)}`,
        manifestPath,
      };
    }
    const learnRef = resolveLearnFile(rootDir, raw);
    if (learnRef && !learnRef.ok) return { ok: false, error: learnRef.error, manifestPath };
    const parsed = parseManifestV2(id, learnRef?.ok ? learnRef.raw : raw);
    if (!parsed.ok) return { ok: false, error: parsed.error, manifestPath };
    v2 = parsed.fields;
  }
  const parsedListing = parseListing(raw.listing);

  let minHostVersion: string | undefined;
  if (raw.minHostVersion !== undefined) {
    if (!isValidSemver(raw.minHostVersion)) {
      return { ok: false, error: "minHostVersion must be a semver version", manifestPath };
    }
    minHostVersion = raw.minHostVersion.trim();
  }
  const update = parseUpdateBlock(raw.update);
  if (typeof update === "string") return { ok: false, error: update, manifestPath };

  return {
    ok: true,
    manifest: {
      id,
      configSchema,
      kind,
      channels,
      providers,
      skills,
      name,
      description,
      version,
      uiHints,
      ui,
      v2,
      listing: parsedListing.listing,
      listingWarnings: parsedListing.warnings.length ? parsedListing.warnings : undefined,
      ...(raw.access !== undefined ? { access: parseManifestAccess(raw.access) } : {}),
      ...(minHostVersion ? { minHostVersion } : {}),
      ...(update ? { update } : {}),
    },
    manifestPath,
  };
}

/**
 * `contributes.learn` may name a JSON file inside the plugin
 * (`"learn": "learn.json"` or `{ "file": "learn.json" }`) instead of inlining
 * the tracks. Inline it here so the pure v2 parser validates the content.
 * Returns null when there is nothing to resolve.
 */
function resolveLearnFile(
  rootDir: string,
  raw: Record<string, unknown>,
): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } | null {
  const contributes = isRecord(raw.contributes) ? raw.contributes : null;
  const learn = contributes?.learn;
  const rel =
    typeof learn === "string"
      ? learn
      : isRecord(learn) && typeof learn.file === "string"
        ? learn.file
        : null;
  if (!contributes || !rel) return null;
  const root = path.resolve(rootDir);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !file.endsWith(".json")) {
    return {
      ok: false,
      error: `contributes.learn file "${rel}" must be a .json file inside the plugin`,
    };
  }
  let content: unknown;
  try {
    content = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      error: `contributes.learn file "${rel}" could not be read: ${String(err)}`,
    };
  }
  return { ok: true, raw: { ...raw, contributes: { ...contributes, learn: content } } };
}

// package.json "infinibot" metadata (used for onboarding/catalog)
export type PluginPackageChannel = {
  id?: string;
  label?: string;
  selectionLabel?: string;
  detailLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
  aliases?: string[];
  preferOver?: string[];
  systemImage?: string;
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: string[];
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
};

export type PluginPackageInstall = {
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "npm" | "local";
};

export type InfiniBotPackageManifest = {
  extensions?: string[];
  channel?: PluginPackageChannel;
  install?: PluginPackageInstall;
};

export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  infinibot?: InfiniBotPackageManifest;
};

export function getPackageManifestMetadata(
  manifest: PackageManifest | undefined,
): InfiniBotPackageManifest | undefined {
  if (!manifest) return undefined;
  return manifest.infinibot;
}

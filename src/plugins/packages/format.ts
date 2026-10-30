/**
 * InfiniBot Plugin Package — the distributable form of a plugin.
 *
 * A package is a plain ZIP (`<id>-<version>.ibplugin.zip`; any `.zip` is
 * accepted) holding the plugin exactly as it runs: `infinibot.plugin.json` at
 * the archive root (or inside exactly one top-level folder), prebuilt runtime
 * files, assets and optional CHANGELOG.md / README.md / LICENSE.
 *
 * This module owns the format's constants and the DISTRIBUTION rules a
 * manifest must meet on top of what the loader needs (manifest.ts): a
 * loadable plugin may omit a publisher or a listing, a distributable one may
 * not. Spec: docs/plugins/packaging.md.
 */

import { parseListing } from "../listing.js";
import { parseManifestV2 } from "../manifest-v2.js";
import { listPermissionItems, type PermissionItem } from "../contributions.js";
import { parseSemverStrict } from "./semver.js";

export const PACKAGE_FORMAT = "infinibot-plugin-package@1";
export const PACKAGE_EXTENSION = ".ibplugin.zip";
export const PACKAGE_MANIFEST = "infinibot.plugin.json";
/** Files the host reads from a package besides the manifest (all optional). */
export const PACKAGE_DOC_FILES = ["CHANGELOG.md", "README.md", "LICENSE"] as const;

/** Hard caps applied when reading any package (zip-bomb / abuse guards). */
export const PACKAGE_LIMITS = {
  /** Compressed archive size. */
  maxZipBytes: 100 * 1024 * 1024,
  /** Sum of uncompressed file sizes. */
  maxUnpackedBytes: 500 * 1024 * 1024,
  /** One uncompressed file. */
  maxFileBytes: 100 * 1024 * 1024,
  maxFiles: 10_000,
  /** unpacked / compressed, enforced once unpacked exceeds 1 MB. */
  maxCompressionRatio: 200,
  maxPathLength: 255,
  maxPathDepth: 16,
  maxManifestBytes: 1024 * 1024,
} as const;

export type PackageLimits = { -readonly [K in keyof typeof PACKAGE_LIMITS]: number };

/** Kebab-case, 2–64 chars. Stricter than the loader: it becomes a folder name and a URL segment. */
export const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * Ids an imported package may never claim: they would read as core surfaces
 * in RPC namespaces (`<id>.*`), HTTP paths (`/plugins/<id>/`) or the UI.
 */
export const RESERVED_PACKAGE_IDS: ReadonlySet<string> = new Set([
  "infinibot",
  "core",
  "gateway",
  "system",
  "plugins",
  "plugin",
  "config",
  "chat",
  "sessions",
  "agents",
  "agent",
  "auth",
  "admin",
  "api",
  "marketplace",
  "registry",
  "update",
  "updates",
]);

export type PluginUpdateBlock = {
  /** Registry this plugin's updates come from (overrides `plugins.registryUrl`). */
  registryUrl?: string;
  /** Changelog file inside the package (default CHANGELOG.md). */
  changelog?: string;
};

export type DistributionManifest = {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  license?: string;
  homepage?: string;
  minHostVersion: string;
  pluginApiRange: string;
  permissions: PermissionItem[];
  update?: PluginUpdateBlock;
};

export type ManifestValidation =
  | { ok: true; manifest: DistributionManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** https everywhere; plain http only for loopback (local registries, tests). */
export function isAllowedPackageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** `update` block → parsed, or an error string. Absent → undefined. */
export function parseUpdateBlock(raw: unknown): PluginUpdateBlock | undefined | string {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return "update must be an object";
  const out: PluginUpdateBlock = {};
  if (raw.registryUrl !== undefined) {
    const url = str(raw.registryUrl);
    if (!url || !isAllowedPackageUrl(url)) {
      return "update.registryUrl must be an https URL (http only for localhost)";
    }
    out.registryUrl = url.replace(/\/+$/, "");
  }
  if (raw.changelog !== undefined) {
    const file = str(raw.changelog);
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) {
      return "update.changelog must be a file path inside the package";
    }
    out.changelog = file;
  }
  const unknown = Object.keys(raw).filter((k) => k !== "registryUrl" && k !== "changelog");
  if (unknown.length) return `update has unknown field(s): ${unknown.join(", ")}`;
  return out;
}

/**
 * Validate a raw `infinibot.plugin.json` for DISTRIBUTION. Pure: no file
 * access, so it runs on a manifest read out of a zip before anything is
 * extracted. Errors block packing/installing; warnings are shown and kept.
 */
export function validateDistributionManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["manifest must be a JSON object"], warnings };
  }

  const id = str(raw.id) ?? "";
  if (!id) errors.push("id is required");
  else if (!PACKAGE_ID_RE.test(id)) {
    errors.push(`id "${id}" must be lowercase letters, digits and dashes (2–64 chars)`);
  } else if (RESERVED_PACKAGE_IDS.has(id)) errors.push(`id "${id}" is reserved`);

  const name = str(raw.name);
  if (!name) errors.push("name is required");
  else if (name.length > 64) errors.push("name must be 64 characters or fewer");

  const version = str(raw.version);
  if (!version) errors.push("version is required");
  else if (parseSemverStrict(version) === null) {
    errors.push(`version "${version}" must be semver (MAJOR.MINOR.PATCH[-prerelease][+build])`);
  }

  const publisher = str(raw.publisher);
  if (!publisher) errors.push("publisher is required (your publisher id)");
  else if (!PACKAGE_ID_RE.test(publisher)) {
    errors.push(`publisher "${publisher}" must be a publisher id (lowercase, digits, dashes)`);
  }

  if (raw.manifestVersion !== 2) {
    errors.push("manifestVersion must be 2 (packages are manifest-v2 plugins)");
  }

  const minHostVersion = str(raw.minHostVersion);
  if (!minHostVersion) errors.push("minHostVersion is required (oldest InfiniBot that runs it)");
  else if (parseSemverStrict(minHostVersion) === null) {
    errors.push(`minHostVersion "${minHostVersion}" must be semver`);
  }

  if (!isRecord(raw.configSchema)) {
    errors.push('configSchema is required (use { "type": "object", "properties": {} } for none)');
  }

  if (!isRecord(raw.permissions)) {
    errors.push("permissions is required (use {} when the plugin needs none)");
  }

  if (!isRecord(raw.listing)) {
    errors.push("listing is required (tagline + description at minimum)");
  } else {
    const parsed = parseListing(raw.listing);
    for (const w of parsed.warnings) errors.push(w);
    if (!parsed.listing?.tagline) errors.push("listing.tagline is required");
    if (!parsed.listing?.description) errors.push("listing.description is required");
    if (!parsed.listing?.category) warnings.push("listing.category is not set (shown as Apps)");
    if (!parsed.listing?.icon) warnings.push("listing.icon is not set (a monogram is shown)");
    if (!parsed.listing?.cover)
      warnings.push("listing.cover is not set (a generated cover is shown)");
  }

  const update = parseUpdateBlock(raw.update);
  if (typeof update === "string") errors.push(update);

  let pluginApiRange = "";
  if (id && raw.manifestVersion === 2) {
    // The v2 contract (contributes, permissions, engines) — same parser the
    // loader runs, so a package that validates here also loads.
    const v2 = parseManifestV2(id, raw);
    if (!v2.ok) errors.push(v2.error);
    else pluginApiRange = v2.fields.engines.pluginApi;
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    manifest: {
      id,
      name: name as string,
      version: version as string,
      publisher: publisher as string,
      description: str(raw.description),
      license: str(raw.license),
      homepage: str(raw.homepage),
      minHostVersion: minHostVersion as string,
      pluginApiRange,
      permissions: listPermissionItems(raw.permissions as Record<string, unknown>),
      ...(update && typeof update !== "string" ? { update } : {}),
    },
  };
}

/** Permission keys a manifest requests (stable, sorted) — the review snapshot. */
export function permissionKeysOf(permissions: unknown): string[] {
  return listPermissionItems(isRecord(permissions) ? permissions : undefined)
    .map((p) => p.key)
    .sort();
}

/** Keys in `next` that `reviewed` never covered → the owner must be asked again. */
export function newPermissionKeys(next: readonly string[], reviewed: readonly string[]): string[] {
  const seen = new Set(reviewed);
  return next.filter((k) => !seen.has(k));
}

/** Entry file names the loader accepts when package.json names none. */
export const PACKAGE_INDEX_FILES = ["index.ts", "index.js", "index.mjs", "index.cjs"] as const;

/**
 * Entry files of a package, from its (optional) package.json. Returns an
 * error string when `infinibot.extensions` is malformed or leaves the package.
 */
export function resolvePackageEntries(
  packageJson: unknown,
  hasFile: (rel: string) => boolean,
): string[] | string {
  const declared =
    isRecord(packageJson) && isRecord(packageJson.infinibot)
      ? packageJson.infinibot.extensions
      : undefined;
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.length === 0) {
      return "package.json infinibot.extensions must be a non-empty list";
    }
    const out: string[] = [];
    for (const entry of declared) {
      const rel = typeof entry === "string" ? entry.trim().replace(/^\.\//, "") : "";
      if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
        return `package.json infinibot.extensions entry "${String(entry)}" must be a path inside the package`;
      }
      if (!hasFile(rel)) return `entry file "${rel}" is missing from the package`;
      out.push(rel);
    }
    return out;
  }
  const index = PACKAGE_INDEX_FILES.find((f) => hasFile(f));
  if (!index) {
    return `no entry file: add ${PACKAGE_INDEX_FILES.join(" / ")} or package.json infinibot.extensions`;
  }
  return [index];
}

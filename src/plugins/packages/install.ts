/**
 * Install / update / roll back InfiniBot Plugin Packages.
 *
 * Two steps, so the owner reviews before anything lands:
 *
 *  1. `inspectPluginPackage(buffer)` — verifies the checksum, opens the zip
 *     with the hardened reader, validates the manifest (read from the zip, not
 *     extracted), applies the host-version gate, the id collision rules and
 *     the cloud tenant policy, and reports what the plugin asks permission
 *     for. Nothing is written.
 *  2. `commitPluginPackage(inspection, …)` — only with the permissions
 *     accepted: extracts to a staging folder, re-validates what landed on
 *     disk, then swaps it into `<configDir>/extensions/<id>` with renames. The
 *     version it replaces is kept for one-step rollback. Any failure restores
 *     the previous state.
 *
 * Neither step enables the plugin or grants a gated permission: a fresh
 * install is OFF until the owner turns it on; an update keeps the owner's
 * existing choices. Callers persist the returned config.
 *
 * Spec: docs/plugins/packaging.md, docs/plugins/security-model.md.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { InfinibotConfig } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { cloudPluginDecision, isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import { VERSION } from "../../version.js";
import type { PermissionItem } from "../contributions.js";
import { loadPluginManifest } from "../manifest.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { PLUGIN_API_VERSION, satisfiesRange } from "../manifest-v2.js";
import {
  PACKAGE_MANIFEST,
  newPermissionKeys,
  permissionKeysOf,
  resolvePackageEntries,
  validateDistributionManifest,
  type DistributionManifest,
  type PackageLimits,
} from "./format.js";
import { compareSemver, hostSatisfiesMin, isValidSemver } from "./semver.js";
import { isInsideDir, resolvePackagePaths, type PackagePaths } from "./store.js";
import { normalizeSha256, openPluginZip, PackageError, type OpenedPluginZip } from "./zip-read.js";

export type PackageSource =
  | { kind: "zip"; fileName?: string; path?: string }
  | { kind: "url"; url: string }
  | { kind: "registry"; registryUrl: string; firstParty: boolean; url?: string };

/** A plugin with the same id that the host already knows about. */
export type ExistingPlugin = {
  origin: "bundled" | "global" | "workspace" | "config";
  version?: string;
  rootDir: string;
};

export type PackageAction =
  /** New plugin. */
  | "install"
  /** Newer version of an installed package. */
  | "update"
  /** Same version again (repair). */
  | "reinstall"
  /** Older version than the one installed. */
  | "downgrade"
  /** Newer version of a plugin that ships with InfiniBot. */
  | "override-bundled"
  /**
   * Nothing to install: this version (or a newer one) of the plugin is
   * already here — it ships with InfiniBot, or the same package is installed.
   * The caller offers to turn the existing copy on instead.
   */
  | "already-installed";

export type PackageInspection = {
  manifest: DistributionManifest;
  action: PackageAction;
  currentVersion?: string;
  sha256: string;
  sizeBytes: number;
  unpackedBytes: number;
  files: number;
  permissions: PermissionItem[];
  /** Every permission key the package requests. */
  permissionKeys: string[];
  /** Keys the owner has not reviewed yet (all of them on a fresh install). */
  newPermissions: string[];
  /** Gated (default-off) permissions: listed for review, never granted here. */
  gatedPermissions: string[];
  /** The override of a bundled plugin needs the owner's explicit say-so. */
  needsOverrideConfirmation: boolean;
  /** For "already-installed": where the copy in use comes from. */
  existingOrigin?: "bundled" | "package";
  warnings: string[];
  changelog?: string;
  entries: string[];
  source: PackageSource;
  /** Internal: the opened archive, consumed by commit. */
  zip: OpenedPluginZip;
};

export type InspectOptions = {
  buffer: Buffer;
  source: PackageSource;
  config: InfinibotConfig;
  expectedSha256?: string | null;
  expectedId?: string;
  expectedVersion?: string;
  hostVersion?: string;
  env?: NodeJS.ProcessEnv;
  paths?: PackagePaths;
  limits?: Partial<PackageLimits>;
  /** Test seam: plugins already known for an id (default: discovery). */
  resolveExisting?: (id: string) => ExistingPlugin[];
};

const CHANGELOG_PREVIEW_BYTES = 64 * 1024;

function defaultResolveExisting(config: InfinibotConfig): (id: string) => ExistingPlugin[] {
  return (id) =>
    loadPluginManifestRegistry({ config, cache: false })
      .plugins.filter((p) => p.id === id)
      .map((p) => ({ origin: p.origin, version: p.version, rootDir: p.rootDir }));
}

function isPackageRecord(record: PluginInstallRecord | undefined): boolean {
  return record?.source === "zip" || record?.source === "url" || record?.source === "registry";
}

export function isPackageInstall(config: InfinibotConfig, id: string): boolean {
  return isPackageRecord(config.plugins?.installs?.[id]);
}

/**
 * Hosted fleet tenant Machine: a tenant may only install what the platform
 * catalogue + their plan allow, and only from the registry (checksummed).
 * Returns the refusal, or null when the install may proceed.
 */
export function tenantInstallRefusal(
  id: string,
  source: PackageSource,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isFleetTenantMachine(env)) return null;
  const decision = cloudPluginDecision(id, "global", env);
  if (decision && !decision.loadable) {
    return decision.reason ?? "This plugin is not available in InfiniBot Cloud.";
  }
  if (source.kind !== "registry" || !source.firstParty) {
    return "In InfiniBot Cloud, plugins are installed from the marketplace only.";
  }
  return null;
}

export async function inspectPluginPackage(opts: InspectOptions): Promise<PackageInspection> {
  const env = opts.env ?? process.env;
  const hostVersion = opts.hostVersion ?? VERSION;
  const paths = opts.paths ?? resolvePackagePaths();

  const zip = await openPluginZip(opts.buffer, opts.limits);

  if (opts.expectedSha256 !== undefined && opts.expectedSha256 !== null) {
    const want = normalizeSha256(opts.expectedSha256);
    if (!want)
      throw new PackageError("the expected sha256 is not a valid SHA-256 hex digest", "checksum");
    if (want !== zip.sha256) {
      throw new PackageError(
        `checksum mismatch: expected ${want}, the package is ${zip.sha256}`,
        "checksum",
      );
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse((await zip.read(PACKAGE_MANIFEST)).toString("utf-8"));
  } catch (err) {
    if (err instanceof PackageError) throw err;
    throw new PackageError(`${PACKAGE_MANIFEST} is not valid JSON`, "manifest");
  }
  const validation = validateDistributionManifest(raw);
  if (!validation.ok) {
    throw new PackageError(`invalid plugin manifest: ${validation.errors.join("; ")}`, "manifest");
  }
  const manifest = validation.manifest;
  // Listing lint (missing cover, …) is for the publisher at pack time; the
  // person installing only sees warnings that affect their decision.
  const warnings: string[] = [];

  if (opts.expectedId && opts.expectedId !== manifest.id) {
    throw new PackageError(
      `the package is "${manifest.id}", expected "${opts.expectedId}"`,
      "manifest",
    );
  }
  if (opts.expectedVersion && opts.expectedVersion !== manifest.version) {
    throw new PackageError(
      `the package is version ${manifest.version}, expected ${opts.expectedVersion}`,
      "manifest",
    );
  }

  let pkgJson: unknown;
  if (zip.has("package.json")) {
    try {
      pkgJson = JSON.parse((await zip.read("package.json")).toString("utf-8"));
    } catch {
      throw new PackageError("package.json is not valid JSON", "manifest");
    }
  }
  const entries = resolvePackageEntries(pkgJson, (rel) => zip.has(rel));
  if (typeof entries === "string") throw new PackageError(entries, "manifest");

  if (!hostSatisfiesMin(hostVersion, manifest.minHostVersion)) {
    throw new PackageError(
      `${manifest.name} ${manifest.version} needs InfiniBot ${manifest.minHostVersion} or newer (this is ${hostVersion})`,
      "host",
    );
  }
  if (!satisfiesRange(PLUGIN_API_VERSION, manifest.pluginApiRange)) {
    throw new PackageError(
      `${manifest.name} needs plugin API ${manifest.pluginApiRange} (this host provides ${PLUGIN_API_VERSION})`,
      "host",
    );
  }

  const refusal = tenantInstallRefusal(manifest.id, opts.source, env);
  if (refusal) throw new PackageError(refusal, "policy");
  if (opts.config.plugins?.deny?.includes(manifest.id)) {
    throw new PackageError(`"${manifest.id}" is on the plugin denylist`, "policy");
  }

  // ── id collision rules ─────────────────────────────────────────────
  const existing = (opts.resolveExisting ?? defaultResolveExisting(opts.config))(manifest.id);
  const record = opts.config.plugins?.installs?.[manifest.id];
  const targetDir = path.join(paths.extensionsDir, manifest.id);
  const shadow = existing.find((e) => e.origin === "workspace" || e.origin === "config");
  if (shadow) {
    throw new PackageError(
      `a plugin with id "${manifest.id}" is already loaded from ${shadow.rootDir}; remove it before installing the package`,
      "collision",
    );
  }
  const installed = existing.find(
    (e) => e.origin === "global" && path.resolve(e.rootDir) === path.resolve(targetDir),
  );
  const bundled = existing.find((e) => e.origin === "bundled");

  let action: PackageAction = "install";
  let currentVersion: string | undefined;
  let needsOverrideConfirmation = false;

  let existingOrigin: PackageInspection["existingOrigin"];
  if (installed || fs.existsSync(targetDir)) {
    if (!isPackageRecord(record)) {
      throw new PackageError(
        `"${manifest.id}" is already installed in ${targetDir} but not as a package; uninstall it first`,
        "collision",
      );
    }
    currentVersion = installed?.version ?? record?.version;
    if (!currentVersion || !isValidSemver(currentVersion)) action = "update";
    else {
      const c = compareSemver(manifest.version, currentVersion);
      action = c > 0 ? "update" : c === 0 ? "reinstall" : "downgrade";
    }
    // Same version as the package already installed, and the archive is the
    // very same file: nothing to do but switch it on.
    if (action === "reinstall" && record?.sha256 && normalizeSha256(record.sha256) === zip.sha256) {
      action = "already-installed";
      existingOrigin = "package";
    }
  } else if (bundled) {
    currentVersion = bundled.version;
    if (
      currentVersion &&
      isValidSemver(currentVersion) &&
      compareSemver(manifest.version, currentVersion) <= 0
    ) {
      // The copy that ships with InfiniBot is this version or newer: keep it
      // and offer to turn it on (no error, nothing replaced).
      action = "already-installed";
      existingOrigin = "bundled";
    }
  }
  if (action === "already-installed") {
    return {
      manifest,
      action,
      currentVersion,
      existingOrigin,
      sha256: zip.sha256,
      sizeBytes: zip.zipBytes,
      unpackedBytes: zip.unpackedBytes,
      files: zip.files.length,
      permissions: manifest.permissions,
      permissionKeys: [],
      newPermissions: [],
      gatedPermissions: [],
      needsOverrideConfirmation: false,
      warnings,
      entries,
      source: opts.source,
      zip,
    };
  }
  if (!installed && !fs.existsSync(targetDir) && bundled) {
    action = "override-bundled";
    // Anyone can zip a manifest that says id "flypic": only the registry
    // vouching for it as first-party (checksum verified) skips the prompt.
    const vouched =
      opts.source.kind === "registry" && opts.source.firstParty && Boolean(opts.expectedSha256);
    needsOverrideConfirmation = !vouched;
    if (needsOverrideConfirmation) {
      warnings.push(
        `This replaces the ${manifest.name} that ships with InfiniBot. Only continue if you trust where this file came from.`,
      );
    }
  }
  if (bundled && installed && action === "downgrade") {
    warnings.push("An older version than the one installed.");
  }

  const permissionKeys = permissionKeysOf((raw as { permissions?: unknown }).permissions);
  const reviewed = action === "install" ? [] : (record?.reviewedPermissions ?? []);
  const newPermissions =
    action === "override-bundled" && !record
      ? // First override of a bundled plugin: its bundled permissions were
        // already in front of the owner; ask only about what the package adds.
        newPermissionKeys(permissionKeys, bundledPermissionKeys(bundled))
      : newPermissionKeys(permissionKeys, reviewed);

  let changelog: string | undefined;
  const changelogFile = manifest.update?.changelog ?? "CHANGELOG.md";
  if (zip.has(changelogFile)) {
    try {
      changelog = (await zip.read(changelogFile, CHANGELOG_PREVIEW_BYTES)).toString("utf-8");
    } catch {
      warnings.push(`${changelogFile} is too large to preview`);
    }
  }

  return {
    manifest,
    action,
    currentVersion,
    sha256: zip.sha256,
    sizeBytes: zip.zipBytes,
    unpackedBytes: zip.unpackedBytes,
    files: zip.files.length,
    permissions: manifest.permissions,
    permissionKeys,
    newPermissions,
    gatedPermissions: manifest.permissions.filter((p) => p.category === "gated").map((p) => p.key),
    needsOverrideConfirmation,
    warnings,
    changelog,
    entries,
    source: opts.source,
    zip,
  };
}

function bundledPermissionKeys(bundled: ExistingPlugin | undefined): string[] {
  if (!bundled) return [];
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(bundled.rootDir, PACKAGE_MANIFEST), "utf-8"),
    ) as {
      permissions?: unknown;
    };
    return permissionKeysOf(raw.permissions);
  } catch {
    return [];
  }
}

export type CommitOptions = {
  config: InfinibotConfig;
  /** Permission keys the owner accepted in the review step. */
  acceptedPermissions: readonly string[];
  /** Required when the inspection says `needsOverrideConfirmation`. */
  overrideBundled?: boolean;
  allowDowngrade?: boolean;
  allowReinstall?: boolean;
  paths?: PackagePaths;
  now?: () => Date;
};

export type CommitResult = {
  config: InfinibotConfig;
  id: string;
  version: string;
  previousVersion?: string;
  action: PackageAction;
  targetDir: string;
  record: PluginInstallRecord;
  /** Put the disk back the way it was (call when persisting config fails). */
  undo: () => void;
};

function token(): string {
  return randomBytes(6).toString("hex");
}

/** Keep only `keep` inside versions/<id>/ (one-step rollback, not a history). */
function pruneVersions(versionsRoot: string, keep?: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(versionsRoot);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(versionsRoot, name);
    if (keep && path.resolve(abs) === path.resolve(keep)) continue;
    fs.rmSync(abs, { recursive: true, force: true });
  }
}

export async function commitPluginPackage(
  inspection: PackageInspection,
  opts: CommitOptions,
): Promise<CommitResult> {
  const paths = opts.paths ?? resolvePackagePaths();
  const now = (opts.now ?? (() => new Date()))();
  const { manifest, action } = inspection;
  const id = manifest.id;

  if (action === "already-installed") {
    throw new PackageError(
      `${manifest.name} ${inspection.currentVersion ?? manifest.version} is already here; turn it on instead of installing it again`,
      "collision",
    );
  }
  const missing = inspection.newPermissions.filter((k) => !opts.acceptedPermissions.includes(k));
  if (missing.length) {
    throw new PackageError(
      `review needed: ${manifest.name} asks for ${missing.length} permission(s) you have not accepted (${missing.join(", ")})`,
      "permissions",
    );
  }
  if (inspection.needsOverrideConfirmation && opts.overrideBundled !== true) {
    throw new PackageError(
      `${manifest.name} ships with InfiniBot; confirm that this package should replace it`,
      "collision",
    );
  }
  if (action === "downgrade" && !opts.allowDowngrade) {
    throw new PackageError(
      `${manifest.name} ${inspection.currentVersion} is installed; ${manifest.version} is older (use rollback, or allow the downgrade)`,
      "collision",
    );
  }
  if (action === "reinstall" && !opts.allowReinstall) {
    throw new PackageError(
      `${manifest.name} ${manifest.version} is already installed`,
      "collision",
    );
  }

  const targetDir = path.join(paths.extensionsDir, id);
  const versionsRoot = path.join(paths.versionsDir, id);
  const staged = path.join(paths.stagingDir, `${id}-${token()}`);
  fs.mkdirSync(paths.extensionsDir, { recursive: true });
  fs.mkdirSync(paths.stagingDir, { recursive: true, mode: 0o700 });

  // ── stage ──────────────────────────────────────────────────────────
  try {
    await inspection.zip.extractTo(staged);
    // What landed on disk must be the plugin that was reviewed.
    const loaded = loadPluginManifest(staged);
    if (!loaded.ok) throw new PackageError(loaded.error, "manifest");
    if (loaded.manifest.id !== id || loaded.manifest.version !== manifest.version) {
      throw new PackageError("the extracted manifest differs from the reviewed one", "manifest");
    }
    for (const entry of inspection.entries) {
      const abs = path.join(staged, ...entry.split("/"));
      if (!fs.statSync(abs).isFile())
        throw new PackageError(`entry "${entry}" is not a file`, "manifest");
    }
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }

  // ── swap ───────────────────────────────────────────────────────────
  const prevRecord = opts.config.plugins?.installs?.[id];
  let retired: string | undefined;
  try {
    if (fs.existsSync(targetDir)) {
      if (fs.lstatSync(targetDir).isSymbolicLink()) {
        throw new PackageError(`${targetDir} is a symlink; refusing to replace it`, "collision");
      }
      fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
      retired = path.join(versionsRoot, `${inspection.currentVersion ?? "unknown"}-${token()}`);
      fs.renameSync(targetDir, retired);
    }
    fs.renameSync(staged, targetDir);
  } catch (err) {
    if (retired && !fs.existsSync(targetDir)) {
      try {
        fs.renameSync(retired, targetDir);
      } catch {
        /* reported below */
      }
    }
    fs.rmSync(staged, { recursive: true, force: true });
    throw err instanceof PackageError
      ? err
      : new PackageError(`could not install into ${targetDir}: ${String(err)}`, "collision");
  }

  const previous: PluginInstallRecord["previous"] =
    action === "override-bundled" && !retired
      ? { version: inspection.currentVersion ?? "bundled", bundled: true }
      : retired
        ? {
            version: inspection.currentVersion ?? prevRecord?.version ?? "unknown",
            path: retired,
            ...(prevRecord?.sha256 ? { sha256: prevRecord.sha256 } : {}),
            ...(prevRecord?.installedAt ? { installedAt: prevRecord.installedAt } : {}),
          }
        : undefined;

  const reviewed = [
    ...new Set([
      ...(action === "install" ? [] : (prevRecord?.reviewedPermissions ?? [])),
      ...inspection.permissionKeys,
    ]),
  ].sort();

  const record: PluginInstallRecord = {
    source: inspection.source.kind,
    installPath: targetDir,
    version: manifest.version,
    installedAt: now.toISOString(),
    sha256: inspection.sha256,
    sizeBytes: inspection.sizeBytes,
    reviewedPermissions: reviewed,
    ...(inspection.source.kind === "zip" && inspection.source.path
      ? { sourcePath: inspection.source.path }
      : {}),
    ...(inspection.source.kind === "url" ? { sourceUrl: inspection.source.url } : {}),
    ...(inspection.source.kind === "registry"
      ? {
          registryUrl: inspection.source.registryUrl,
          ...(inspection.source.url ? { sourceUrl: inspection.source.url } : {}),
        }
      : {}),
    ...(action === "override-bundled" || prevRecord?.overridesBundled
      ? { overridesBundled: true }
      : {}),
    ...(previous ? { previous } : {}),
  };

  const plugins = { ...opts.config.plugins };
  plugins.installs = { ...plugins.installs, [id]: record };
  if (action === "install") {
    // A fresh import never inherits a leftover "on" switch or old grants.
    const entries = { ...plugins.entries } as Record<string, Record<string, unknown>>;
    const stale = entries[id];
    if (stale) {
      const { permissions: _grants, enabled: _enabled, ...rest } = stale;
      entries[id] = { ...rest, enabled: false };
      plugins.entries = entries as typeof plugins.entries;
    }
  }
  const config = { ...opts.config, plugins } as InfinibotConfig;

  // Only now is the older rollback copy dropped (one step, not a history).
  pruneVersions(versionsRoot, retired);

  return {
    config,
    id,
    version: manifest.version,
    previousVersion: inspection.currentVersion,
    action,
    targetDir,
    record,
    undo: () => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      if (retired && fs.existsSync(retired)) fs.renameSync(retired, targetDir);
    },
  };
}

export type RollbackResult = {
  config: InfinibotConfig;
  id: string;
  /** Version now active. */
  version: string;
  /** Version that was rolled back from. */
  from: string;
  restored: "previous-package" | "bundled";
  undo: () => void;
};

/**
 * One-step rollback: put the previous version back and keep the one being
 * retired as the new "previous" (so a rollback can itself be undone). When
 * the previous version was the bundled copy, the override is removed.
 */
export function rollbackPluginPackage(opts: {
  id: string;
  config: InfinibotConfig;
  paths?: PackagePaths;
  now?: () => Date;
}): RollbackResult {
  const paths = opts.paths ?? resolvePackagePaths();
  const now = (opts.now ?? (() => new Date()))();
  const record = opts.config.plugins?.installs?.[opts.id];
  if (!record || !isPackageRecord(record)) {
    throw new PackageError(`"${opts.id}" was not installed as a package`, "collision");
  }
  const prev = record.previous;
  if (!prev) throw new PackageError(`no previous version of "${opts.id}" is kept`, "collision");
  const targetDir = path.join(paths.extensionsDir, opts.id);
  const versionsRoot = path.join(paths.versionsDir, opts.id);
  const from = record.version ?? "unknown";
  if (!fs.existsSync(targetDir)) {
    throw new PackageError(`${targetDir} is missing; nothing to roll back`, "collision");
  }
  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const retired = path.join(versionsRoot, `${from}-${token()}`);
  const plugins = { ...opts.config.plugins };
  const installs = { ...plugins.installs };

  if (prev.bundled || !prev.path) {
    fs.renameSync(targetDir, retired);
    delete installs[opts.id];
    plugins.installs = installs;
    pruneVersions(versionsRoot, retired);
    return {
      config: { ...opts.config, plugins } as InfinibotConfig,
      id: opts.id,
      version: prev.version,
      from,
      restored: "bundled",
      undo: () => {
        if (!fs.existsSync(targetDir) && fs.existsSync(retired)) fs.renameSync(retired, targetDir);
      },
    };
  }

  const prevPath = path.resolve(prev.path);
  if (!isInsideDir(prevPath, paths.versionsDir) || !fs.existsSync(prevPath)) {
    throw new PackageError(
      `the previous version of "${opts.id}" is no longer on disk`,
      "collision",
    );
  }
  const check = loadPluginManifest(prevPath);
  if (!check.ok || check.manifest.id !== opts.id) {
    throw new PackageError(
      `the kept previous version of "${opts.id}" is not a valid plugin`,
      "manifest",
    );
  }
  fs.renameSync(targetDir, retired);
  try {
    fs.renameSync(prevPath, targetDir);
  } catch (err) {
    fs.renameSync(retired, targetDir);
    throw new PackageError(`rollback failed: ${String(err)}`, "collision");
  }
  installs[opts.id] = {
    ...record,
    version: check.manifest.version ?? prev.version,
    sha256: prev.sha256,
    installedAt: now.toISOString(),
    previous: {
      version: from,
      path: retired,
      ...(record.sha256 ? { sha256: record.sha256 } : {}),
      ...(record.installedAt ? { installedAt: record.installedAt } : {}),
    },
  };
  if (!prev.sha256) delete installs[opts.id]!.sha256;
  plugins.installs = installs;
  pruneVersions(versionsRoot, retired);
  return {
    config: { ...opts.config, plugins } as InfinibotConfig,
    id: opts.id,
    version: check.manifest.version ?? prev.version,
    from,
    restored: "previous-package",
    undo: () => {
      if (fs.existsSync(retired)) {
        fs.renameSync(targetDir, prevPath);
        fs.renameSync(retired, targetDir);
      }
    },
  };
}

/** Remove a package install's rollback copies (on uninstall). */
export function removePackageVersions(
  id: string,
  paths: PackagePaths = resolvePackagePaths(),
): void {
  fs.rmSync(path.join(paths.versionsDir, id), { recursive: true, force: true });
}

/**
 * Plugin package Gateway handlers — zip import, updates, rollback, marketplace.
 *
 * Import is review-first, in three calls:
 *   plugins.install.begin / .chunk   upload a zip in base64 chunks (to disk)
 *   plugins.install.inspect          verify + validate WITHOUT installing;
 *                                    source = { uploadId } | { url } |
 *                                    { registry: { id, version?, token? } }  (token: the
 *                                    entitlement from a marketplace purchase page; never stored)
 *   plugins.install.commit           install what was reviewed, with the
 *                                    permissions the owner accepted
 *   plugins.install.cancel
 * A committed install is OFF (the owner turns it on in Setup › Plugins) and
 * gated permissions stay ungranted.
 *
 * Updates (every registry-managed plugin, first-party or not):
 *   plugins.updates.check / .status / .setAuto
 *   plugins.update                   applies, or returns a review when the
 *                                    new version asks for new permissions
 *   plugins.rollback                 back to the one kept previous version
 *
 * Marketplace: plugins.marketplace.list / .get (registry contract:
 * docs/plugins/registry-api.md).
 *
 * All are admin-only: none is listed in READ/WRITE_METHODS.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { InfinibotConfig } from "../../config/config.js";
import { normalizePluginsConfig, resolveEnableState } from "../../plugins/config-state.js";
import { buildPluginRecordFromManifest, supersededPluginRoots } from "../../plugins/loader.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { PACKAGE_LIMITS, isAllowedPackageUrl } from "../../plugins/packages/format.js";
import {
  commitPluginPackage,
  inspectPluginPackage,
  rollbackPluginPackage,
  tenantInstallRefusal,
  type CommitResult,
  type PackageInspection,
} from "../../plugins/packages/install.js";
import {
  createRegistryClient,
  fetchPackage,
  formatPrice,
  PaymentRequiredError,
} from "../../plugins/packages/registry-client.js";
import { hostSatisfiesMin, isNewerVersion } from "../../plugins/packages/semver.js";
import {
  readUpdateState,
  resolvePackagePaths,
  sweepStaleStaging,
  writeUpdateState,
} from "../../plugins/packages/store.js";
import {
  checkPluginUpdates,
  marketplaceRegistryUrl,
  prepareRegistryInstall,
  setAutoUpdateInConfig,
  type InstalledPluginRef,
} from "../../plugins/packages/updates.js";
import { resolveGithubPackageUrl } from "../../plugins/packages/github-source.js";
import { PackageError } from "../../plugins/packages/zip-read.js";
import { pluginAccessDecision } from "../../plugins/entitlements/access.js";
import { loadConfig } from "../../config/config.js";
import { appendPluginLog } from "../../plugins/plugin-logs.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { cloudPluginDecision, isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import { VERSION } from "../../version.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { bad, readConfigFileSnapshot, scheduleRestart, writeConfig } from "./plugins.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Respond = GatewayRequestHandlerOptions["respond"];

const UPLOAD_CHUNK_BYTES = 256 * 1024;
const SESSION_TTL_MS = 20 * 60_000;
const MAX_SESSIONS = 8;
const UPDATE_CACHE_FRESH_MS = 10 * 60_000;
const MARKET_CACHE_MS = 5 * 60_000;

type Upload = {
  id: string;
  file: string;
  fileName: string;
  size: number;
  received: number;
  next: number;
  at: number;
};
type Review = { id: string; inspection: PackageInspection; at: number };

const uploads = new Map<string, Upload>();
const reviews = new Map<string, Review>();

function token(): string {
  return randomBytes(12).toString("hex");
}

function expire(): void {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.at > SESSION_TTL_MS) {
      fs.rmSync(u.file, { force: true });
      uploads.delete(id);
    }
  }
  for (const [id, r] of reviews) if (now - r.at > SESSION_TTL_MS) reviews.delete(id);
}

function fail(respond: Respond, err: unknown): void {
  if (err instanceof PaymentRequiredError) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, err.message, {
        details: { code: "payment_required", purchaseUrl: err.purchaseUrl, pluginId: err.pluginId },
      }),
    );
    return;
  }
  const code = err instanceof PackageError ? err.code : "error";
  const message = err instanceof Error ? err.message : String(err);
  bad(respond, plainPackageError(code, message), { code, detail: message });
}

/**
 * The refusal in plain words first, the technical detail after. Only real
 * reasons refuse an import (damaged file, wrong fingerprint, unsafe content,
 * not a plugin, needs a newer InfiniBot, blocked by policy).
 */
export function plainPackageError(code: string, message: string): string {
  switch (code) {
    case "bad-zip":
      return `This file is damaged or isn't a plugin package. Download it again and retry. (${message})`;
    case "checksum":
      return `This file doesn't match its published fingerprint, so it may be damaged or altered. Download it again from where you got it. (${message})`;
    case "unsafe-path":
    case "symlink":
      return `This package tries to put files outside its own folder, so it was refused for your safety. (${message})`;
    case "layout":
    case "manifest":
      return `This doesn't look like an InfiniBot plugin: ${message}`;
    case "host":
      return `This plugin needs a newer InfiniBot. Update InfiniBot, then import it again. (${message})`;
    case "too-large":
      return `This file is too big to import. (${message})`;
    case "network":
      return `Couldn't download the plugin: ${message}`;
    default:
      return message;
  }
}

/** One ref per plugin id (the active record), for the update engine. */
export function installedPluginRefs(): InstalledPluginRef[] {
  const seen = new Set<string>();
  const out: InstalledPluginRef[] = [];
  for (const p of getActivePluginRegistry()?.plugins ?? []) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      version: p.version,
      origin: p.origin,
      publisher: p.publisher,
      updateRegistryUrl: p.updateRegistryUrl,
      loaded: p.status === "loaded",
    });
  }
  return out;
}

function isLoaded(id: string): boolean {
  return (getActivePluginRegistry()?.plugins ?? []).some(
    (p) => p.id === id && p.status === "loaded",
  );
}

/**
 * Re-list one plugin from disk without loading its code, so a just-installed
 * (still off) plugin shows up — and a rolled-back one shows its old version —
 * with no gateway restart. Only for plugins that are not running.
 */
export function refreshPluginRecordFromDisk(id: string, config: InfinibotConfig): boolean {
  const registry = getActivePluginRegistry();
  if (!registry) return false;
  const manifests = loadPluginManifestRegistry({ config, cache: false });
  const superseded = supersededPluginRoots(manifests.plugins);
  const winner = manifests.plugins.find((m) => m.id === id && !superseded.has(m.rootDir));
  const kept = registry.plugins.filter((p) => p.id !== id);
  registry.plugins.length = 0;
  registry.plugins.push(...kept);
  if (!winner) return false;
  const state = resolveEnableState(id, winner.origin, normalizePluginsConfig(config.plugins));
  const record = buildPluginRecordFromManifest(winner, {
    source: winner.source,
    origin: winner.origin,
    workspaceDir: winner.workspaceDir,
    enabled: false,
  });
  record.status = "disabled";
  record.error = state.enabled ? "restart the gateway to load it" : state.reason;
  registry.plugins.push(record);
  return true;
}

function reviewPayload(review: Review) {
  const i = review.inspection;
  const blockedPermissions = isFleetTenantMachine()
    ? (cloudPluginDecision(i.manifest.id, "global")?.blockedPermissions ?? {})
    : {};
  return {
    reviewId: review.id,
    plugin: {
      id: i.manifest.id,
      name: i.manifest.name,
      version: i.manifest.version,
      publisher: i.manifest.publisher,
      description: i.manifest.description,
      license: i.manifest.license,
      homepage: i.manifest.homepage,
      minHostVersion: i.manifest.minHostVersion,
    },
    action: i.action,
    currentVersion: i.currentVersion ?? null,
    sha256: i.sha256,
    sizeBytes: i.sizeBytes,
    unpackedBytes: i.unpackedBytes,
    files: i.files,
    source: i.source.kind,
    firstParty: i.source.kind === "registry" && i.source.firstParty,
    permissions: i.permissions.map((p) => ({
      key: p.key,
      category: p.category,
      value: p.value,
      label: p.label,
      consent: p.consent,
      isNew: i.newPermissions.includes(p.key),
      gated: p.category === "gated",
      blocked: blockedPermissions[p.key] ?? null,
    })),
    newPermissions: i.newPermissions,
    needsOverrideConfirmation: i.needsOverrideConfirmation,
    ...(i.action === "already-installed"
      ? { existing: existingPluginState(i.manifest.id, i.existingOrigin) }
      : {}),
    warnings: i.warnings,
    changelog: i.changelog ?? null,
    notes: {
      enable:
        "Installing does not turn the plugin on. Turn it on in Setup › Plugins when you are ready.",
      gated: "High-risk permissions stay off until you grant them one by one.",
      restart: isLoaded(i.manifest.id)
        ? "This plugin is running: applying the change restarts the gateway (open connections reconnect, running sub-agents stop)."
        : null,
    },
  };
}

/** For an import that is already here: is it on, and may it be turned on? */
function existingPluginState(id: string, origin: PackageInspection["existingOrigin"]) {
  const record = (getActivePluginRegistry()?.plugins ?? []).find((p) => p.id === id);
  const access = pluginAccessDecision(id, { manifestAccess: record?.manifestAccess });
  let enabled = Boolean(record?.enabled);
  try {
    const entry = (
      loadConfig().plugins?.entries as Record<string, { enabled?: boolean }> | undefined
    )?.[id];
    enabled = enabled || entry?.enabled === true;
  } catch {
    // config unreadable: the registry answer stands
  }
  return {
    origin: origin ?? "bundled",
    name: record?.name ?? id,
    version: record?.version ?? null,
    enabled,
    loaded: record?.status === "loaded",
    access,
  };
}

function remember(inspection: PackageInspection): Review {
  expire();
  while (reviews.size >= MAX_SESSIONS) {
    const oldest = [...reviews.values()].sort((a, b) => a.at - b.at)[0];
    if (!oldest) break;
    reviews.delete(oldest.id);
  }
  const review: Review = { id: token(), inspection, at: Date.now() };
  reviews.set(review.id, review);
  return review;
}

/** Persist a commit/rollback: write config (undo the disk change if that fails), then reload or re-list. */
async function persist(
  respond: Respond,
  result: Pick<CommitResult, "config" | "undo"> & { id: string },
  reason: string,
): Promise<{ restart?: ReturnType<typeof scheduleRestart>; restartRequired: boolean } | undefined> {
  const wasLoaded = isLoaded(result.id);
  let written: InfinibotConfig | undefined;
  try {
    // Apply only the plugins block the installer produced onto the CURRENT
    // file (another write may have landed since the review started).
    written = await writeConfig(respond, (cfg) => ({
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: result.config.plugins?.installs,
        entries: result.config.plugins?.entries,
      },
    }));
  } catch (err) {
    result.undo();
    fail(respond, err);
    return undefined;
  }
  if (!written) {
    result.undo();
    return undefined;
  }
  // The cached "update available" for this plugin is stale now.
  const state = readUpdateState();
  if (state.plugins[result.id] || state.pendingRestart?.[result.id]) {
    delete state.plugins[result.id];
    if (state.pendingRestart) delete state.pendingRestart[result.id];
    writeUpdateState(state);
  }
  if (wasLoaded) {
    return { restart: scheduleRestart(reason), restartRequired: true };
  }
  refreshPluginRecordFromDisk(result.id, written);
  return { restartRequired: false };
}

let marketCache: { url: string; at: number; payload: unknown } | null = null;

export const pluginPackageHandlers: GatewayRequestHandlers = {
  "plugins.install.begin": ({ params, respond }) => {
    expire();
    const p = params as { fileName?: unknown; sizeBytes?: unknown };
    const size = typeof p.sizeBytes === "number" ? p.sizeBytes : NaN;
    if (!Number.isInteger(size) || size <= 0)
      return bad(respond, "expected { fileName, sizeBytes }");
    if (size > PACKAGE_LIMITS.maxZipBytes) {
      return bad(
        respond,
        `the file is ${size} bytes; packages are limited to ${PACKAGE_LIMITS.maxZipBytes}`,
        {
          code: "too-large",
        },
      );
    }
    if (uploads.size >= MAX_SESSIONS)
      return bad(respond, "too many uploads in progress; try again shortly");
    const paths = resolvePackagePaths();
    sweepStaleStaging(paths);
    fs.mkdirSync(paths.uploadsDir, { recursive: true, mode: 0o700 });
    const id = token();
    const file = path.join(paths.uploadsDir, `${id}.part`);
    fs.writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
    const fileName =
      typeof p.fileName === "string" ? path.basename(p.fileName).slice(0, 200) : "plugin.zip";
    uploads.set(id, { id, file, fileName, size, received: 0, next: 0, at: Date.now() });
    respond(true, {
      uploadId: id,
      chunkBytes: UPLOAD_CHUNK_BYTES,
      maxBytes: PACKAGE_LIMITS.maxZipBytes,
    });
  },

  "plugins.install.chunk": ({ params, respond }) => {
    const p = params as { uploadId?: unknown; index?: unknown; data?: unknown };
    const upload = typeof p.uploadId === "string" ? uploads.get(p.uploadId) : undefined;
    if (!upload) return bad(respond, "unknown or expired upload");
    if (p.index !== upload.next) return bad(respond, `expected chunk ${upload.next}`);
    if (typeof p.data !== "string")
      return bad(respond, "expected { uploadId, index, data: base64 }");
    const chunk = Buffer.from(p.data, "base64");
    if (chunk.length === 0 || chunk.length > UPLOAD_CHUNK_BYTES * 2)
      return bad(respond, "bad chunk size");
    if (upload.received + chunk.length > upload.size) {
      fs.rmSync(upload.file, { force: true });
      uploads.delete(upload.id);
      return bad(respond, "upload is larger than declared", { code: "too-large" });
    }
    fs.appendFileSync(upload.file, chunk);
    upload.received += chunk.length;
    upload.next += 1;
    upload.at = Date.now();
    respond(true, { received: upload.received, complete: upload.received === upload.size });
  },

  "plugins.install.inspect": async ({ params, respond }) => {
    const p = params as {
      uploadId?: unknown;
      url?: unknown;
      sha256?: unknown;
      registry?: { id?: unknown; version?: unknown; token?: unknown };
    };
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid)
      return bad(respond, "config file is invalid; fix it before installing plugins");
    const config = snapshot.config;
    const expectedSha256 = typeof p.sha256 === "string" && p.sha256.trim() ? p.sha256 : undefined;
    try {
      if (p.registry && typeof p.registry.id === "string") {
        const entitlement =
          typeof p.registry.token === "string" ? p.registry.token.trim() : undefined;
        const { inspection } = await prepareRegistryInstall(
          {
            id: p.registry.id.trim(),
            version: typeof p.registry.version === "string" ? p.registry.version : undefined,
            token: entitlement || undefined,
          },
          { config },
        );
        return respond(true, reviewPayload(remember(inspection)));
      }
      if (typeof p.url === "string") {
        let url = p.url.trim();
        // A GitHub repo / branch / release link → the package it stands for.
        const gh = await resolveGithubPackageUrl(url);
        if (gh.kind === "refused") return bad(respond, gh.reason, { code: "layout" });
        if (gh.kind === "resolved") url = gh.url;
        if (!isAllowedPackageUrl(url))
          return bad(respond, "the URL must be https (http only for localhost)");
        // Policy first: a tenant must not make the gateway fetch arbitrary URLs.
        if (isFleetTenantMachine()) {
          return bad(
            respond,
            "In InfiniBot Cloud, plugins are installed from the marketplace only.",
            {
              code: "policy",
            },
          );
        }
        const dl = await fetchPackage(url);
        const inspection = await inspectPluginPackage({
          buffer: dl.buffer,
          source: { kind: "url", url: dl.url },
          config,
          expectedSha256,
        });
        return respond(true, reviewPayload(remember(inspection)));
      }
      const upload = typeof p.uploadId === "string" ? uploads.get(p.uploadId) : undefined;
      if (!upload) return bad(respond, "expected { uploadId } | { url } | { registry: { id } }");
      if (upload.received !== upload.size) return bad(respond, "the upload is not complete");
      const buffer = fs.readFileSync(upload.file);
      fs.rmSync(upload.file, { force: true });
      uploads.delete(upload.id);
      const inspection = await inspectPluginPackage({
        buffer,
        source: { kind: "zip", fileName: upload.fileName },
        config,
        expectedSha256,
      });
      respond(true, reviewPayload(remember(inspection)));
    } catch (err) {
      fail(respond, err);
    }
  },

  "plugins.install.commit": async ({ params, respond }) => {
    expire();
    const p = params as {
      reviewId?: unknown;
      acceptedPermissions?: unknown;
      overrideBundled?: unknown;
      allowDowngrade?: unknown;
      allowReinstall?: unknown;
    };
    const review = typeof p.reviewId === "string" ? reviews.get(p.reviewId) : undefined;
    if (!review) return bad(respond, "this review expired; start the install again");
    const accepted = Array.isArray(p.acceptedPermissions)
      ? p.acceptedPermissions.filter((k): k is string => typeof k === "string")
      : [];
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid)
      return bad(respond, "config file is invalid; fix it before installing plugins");
    let commit: CommitResult;
    try {
      commit = await commitPluginPackage(review.inspection, {
        config: snapshot.config,
        acceptedPermissions: accepted,
        overrideBundled: p.overrideBundled === true,
        allowDowngrade: p.allowDowngrade === true,
        allowReinstall: p.allowReinstall === true,
      });
    } catch (err) {
      return fail(respond, err);
    }
    reviews.delete(review.id);
    const done = await persist(respond, commit, `plugins.install ${commit.id}@${commit.version}`);
    if (!done) return;
    appendPluginLog(
      commit.id,
      "info",
      `${commit.action} ${commit.previousVersion ? `${commit.previousVersion} → ` : ""}${commit.version} (${commit.record.source}, sha256 ${commit.record.sha256?.slice(0, 12)}…)`,
    );
    respond(true, {
      ok: true,
      id: commit.id,
      version: commit.version,
      previousVersion: commit.previousVersion ?? null,
      action: commit.action,
      sha256: commit.record.sha256,
      rollbackAvailable: Boolean(commit.record.previous),
      ...done,
    });
  },

  "plugins.install.cancel": ({ params, respond }) => {
    const p = params as { reviewId?: unknown; uploadId?: unknown };
    if (typeof p.reviewId === "string") reviews.delete(p.reviewId);
    const upload = typeof p.uploadId === "string" ? uploads.get(p.uploadId) : undefined;
    if (upload) {
      fs.rmSync(upload.file, { force: true });
      uploads.delete(upload.id);
    }
    respond(true, { ok: true });
  },

  "plugins.updates.status": ({ respond }) => {
    respond(true, readUpdateState());
  },

  "plugins.updates.check": async ({ params, respond }) => {
    const force = (params as { force?: unknown }).force === true;
    const cached = readUpdateState();
    if (
      !force &&
      cached.checkedAt &&
      Date.now() - Date.parse(cached.checkedAt) < UPDATE_CACHE_FRESH_MS
    ) {
      return respond(true, { ...cached, cached: true });
    }
    const snapshot = await readConfigFileSnapshot();
    try {
      const state = await checkPluginUpdates(installedPluginRefs(), { config: snapshot.config });
      respond(true, { ...state, cached: false });
    } catch (err) {
      fail(respond, err);
    }
  },

  "plugins.updates.setAuto": async ({ params, respond }) => {
    const p = params as { id?: unknown; auto?: unknown };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id || typeof p.auto !== "boolean") return bad(respond, "expected { id, auto: boolean }");
    if (!installedPluginRefs().some((r) => r.id === id))
      return bad(respond, `unknown plugin "${id}"`);
    const auto = p.auto;
    const written = await writeConfig(respond, (cfg) => setAutoUpdateInConfig(cfg, id, auto));
    if (!written) return;
    appendPluginLog(id, "info", `auto-update turned ${auto ? "on" : "off"}`);
    respond(true, { ok: true, id, auto });
  },

  /**
   * Update one plugin to `version` (default: the newest this host can run).
   * When the new version asks for permissions the owner has not seen, nothing
   * is installed: the reply carries a review to confirm via install.commit.
   */
  "plugins.update": async ({ params, respond }) => {
    const p = params as { id?: unknown; version?: unknown; token?: unknown };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) return bad(respond, "expected { id }");
    const ref = installedPluginRefs().find((r) => r.id === id);
    if (!ref) return bad(respond, `unknown plugin "${id}"`);
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid)
      return bad(respond, "config file is invalid; fix it before updating plugins");
    const cached = readUpdateState().plugins[id];
    const entitlement = typeof p.token === "string" && p.token.trim() ? p.token.trim() : undefined;
    try {
      const { inspection } = await prepareRegistryInstall(
        {
          id,
          version: typeof p.version === "string" ? p.version : cached?.latestVersion,
          token: entitlement,
          registryUrl: cached?.registryUrl,
        },
        { config: snapshot.config },
      );
      if (inspection.action === "reinstall" || inspection.action === "already-installed") {
        return respond(true, {
          ok: true,
          status: "up-to-date",
          id,
          version: inspection.manifest.version,
        });
      }
      if (inspection.action === "downgrade") {
        return bad(
          respond,
          `${id} ${inspection.currentVersion} is newer than the registry's ${inspection.manifest.version}`,
        );
      }
      if (inspection.newPermissions.length || inspection.needsOverrideConfirmation) {
        return respond(true, {
          ok: true,
          status: "needs-review",
          review: reviewPayload(remember(inspection)),
        });
      }
      const commit = await commitPluginPackage(inspection, {
        config: snapshot.config,
        acceptedPermissions: [],
      });
      const done = await persist(respond, commit, `plugins.update ${id}@${commit.version}`);
      if (!done) return;
      appendPluginLog(id, "info", `updated ${commit.previousVersion ?? "?"} → ${commit.version}`);
      respond(true, {
        ok: true,
        status: "updated",
        id,
        version: commit.version,
        previousVersion: commit.previousVersion ?? null,
        rollbackAvailable: Boolean(commit.record.previous),
        ...done,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "plugins.rollback": async ({ params, respond }) => {
    const id =
      typeof (params as { id?: unknown }).id === "string"
        ? String((params as { id: string }).id).trim()
        : "";
    if (!id) return bad(respond, "expected { id }");
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) return bad(respond, "config file is invalid; fix it before rolling back");
    try {
      const result = rollbackPluginPackage({ id, config: snapshot.config });
      const done = await persist(respond, result, `plugins.rollback ${id}@${result.version}`);
      if (!done) return;
      appendPluginLog(id, "warn", `rolled back ${result.from} → ${result.version}`);
      respond(true, {
        ok: true,
        id,
        version: result.version,
        from: result.from,
        restored: result.restored,
        ...done,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "plugins.marketplace.list": async ({ params, respond }) => {
    const snapshot = await readConfigFileSnapshot();
    const config = snapshot.config;
    let registryUrl: string;
    try {
      registryUrl = marketplaceRegistryUrl({ config });
    } catch (err) {
      return fail(respond, err);
    }
    const refresh = (params as { refresh?: unknown }).refresh === true;
    const annotate = (index: {
      generatedAt: string;
      plugins: import("../../plugins/packages/registry-client.js").RegistryEntry[];
    }) => {
      const refs = new Map(installedPluginRefs().map((r) => [r.id, r]));
      const installs = config.plugins?.installs ?? {};
      return {
        registryUrl,
        generatedAt: index.generatedAt,
        hostVersion: VERSION,
        plugins: index.plugins.map((e) => {
          const ref = refs.get(e.id);
          const cloud = isFleetTenantMachine() ? cloudPluginDecision(e.id, "global") : null;
          const policyRefusal = tenantInstallRefusal(e.id, {
            kind: "registry",
            registryUrl,
            firstParty: e.firstParty,
          });
          // A paid first-party plugin this install is entitled to (plan / purchase /
          // owner grant): no Buy on its marketplace card.
          const access = e.firstParty ? pluginAccessDecision(e.id) : null;
          return {
            ...e,
            priceLabel: formatPrice(e.pricing),
            entitled: Boolean(access && access.requires.purchase && access.loadable),
            entitledSource: access?.loadable ? (access.source ?? null) : null,
            installed: ref
              ? {
                  version: ref.version ?? null,
                  origin: ref.origin,
                  package: Boolean(installs[e.id]),
                  // A seller-delivered listing has nothing to update from.
                  updateAvailable:
                    e.distribution !== "external" && isNewerVersion(e.version, ref.version),
                }
              : null,
            compatible: hostSatisfiesMin(VERSION, e.minHostVersion),
            cloud,
            blocked: policyRefusal,
          };
        }),
      };
    };
    if (
      !refresh &&
      marketCache &&
      marketCache.url === registryUrl &&
      Date.now() - marketCache.at < MARKET_CACHE_MS
    ) {
      return respond(true, annotate(marketCache.payload as Parameters<typeof annotate>[0]));
    }
    try {
      const index = await createRegistryClient({ registryUrl }).index();
      marketCache = { url: registryUrl, at: Date.now(), payload: index };
      respond(true, annotate(index));
    } catch (err) {
      fail(respond, err);
    }
  },

  "plugins.marketplace.get": async ({ params, respond }) => {
    const id =
      typeof (params as { id?: unknown }).id === "string"
        ? String((params as { id: string }).id).trim()
        : "";
    if (!id) return bad(respond, "expected { id }");
    const snapshot = await readConfigFileSnapshot();
    try {
      const registryUrl = marketplaceRegistryUrl({ config: snapshot.config });
      const detail = await createRegistryClient({ registryUrl }).plugin(id);
      respond(true, {
        registryUrl,
        hostVersion: VERSION,
        plugin: { ...detail, priceLabel: formatPrice(detail.pricing) },
      });
    } catch (err) {
      fail(respond, err);
    }
  },
};

/** Test hook. */
export function resetPluginPackageSessionsForTests(): void {
  uploads.clear();
  reviews.clear();
  marketCache = null;
}

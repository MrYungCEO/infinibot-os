/**
 * Where managed coder installs live, and whether this process may install.
 *
 * Layout (root = `INFINIBOT_CODERS_DIR` or `<shared state dir>/coders`):
 *
 *   <root>/<id>/            npm/uv prefix owned by one coder (rm -rf = uninstall)
 *   <root>/<id>/.install.json   manifest: method, package, version, shims
 *   <root>/bin/<bin>        launcher shim → absolute node + the package entry,
 *                           so a daemon PATH without `node` still runs it
 *   <root>/.npm-cache/      npm cache (never the operator's ~/.npm)
 *
 * Local install: the shared state dir is ~/.infinibot, so the root is
 * ~/.infinibot/coders. Hosted fleet Machine: INFINIBOT_STATE_DIR=/data (the
 * persistent volume), so the root is /data/coders and survives restarts and
 * Machine replacement. `<root>/bin` is put in front of every PATH that
 * bin-detect builds, which is what coder spawns use, so a fresh install
 * resolves on the next spawn without a gateway restart.
 *
 * Policy:
 *   - local (not SaaS): allowed.
 *   - SaaS on a dedicated tenant Machine (FLEET_TENANT_ID set): allowed; the
 *     Machine and its volume belong to that one tenant.
 *   - SaaS in a shared multi-tenant process: disabled. An installed binary runs
 *     as the gateway user and could read every tenant's files, so there is no
 *     safe per-tenant install there. Override only for trusted single-owner
 *     deployments with INFINIBOT_CODERS_ALLOW_SHARED=1.
 *   - INFINIBOT_CODERS_DISABLED=1 turns installs off anywhere.
 */

import path from "node:path";

import {
  DEFAULT_USER_ID,
  getGlobalUserId,
  getScopedUserId,
  resolveSharedDir,
} from "../../config/paths.js";
import { isSaasMode } from "../../saas/config.js";
import type { CoderId } from "./catalog.js";

export type CoderInstallPolicy =
  | { allowed: true; mode: "local" | "fleet" | "shared-override" }
  | { allowed: false; mode: "disabled" | "shared-saas"; reason: string };

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? "").trim());
}

export function coderInstallPolicy(env: NodeJS.ProcessEnv = process.env): CoderInstallPolicy {
  if (truthy(env.INFINIBOT_CODERS_DISABLED)) {
    return {
      allowed: false,
      mode: "disabled",
      reason: "Coder installs are turned off on this instance (INFINIBOT_CODERS_DISABLED).",
    };
  }
  let saas = false;
  try {
    saas = env === process.env ? isSaasMode() : truthy(env.SAAS_MODE);
  } catch {
    saas = truthy(env.SAAS_MODE);
  }
  if (!saas) return { allowed: true, mode: "local" };
  if (env.FLEET_TENANT_ID?.trim()) return { allowed: true, mode: "fleet" };
  if (truthy(env.INFINIBOT_CODERS_ALLOW_SHARED)) return { allowed: true, mode: "shared-override" };
  return {
    allowed: false,
    mode: "shared-saas",
    reason:
      "This workspace runs in a shared multi-tenant process, where installed programs could reach other workspaces. Coders can be installed on a dedicated cloud gateway.",
  };
}

/** Sanitise a tenant namespace into one path segment. */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Root of all managed coder installs for the active scope. Inside a scoped
 * SaaS tenant request (only reachable with the shared-override policy) each
 * tenant gets `<root>/tenants/<ns>` so one tenant's installs never land in, or
 * are resolved from, another's directory.
 */
export function codersRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INFINIBOT_CODERS_DIR?.trim();
  const base = override ? path.resolve(override) : path.join(resolveSharedDir(env), "coders");
  // Hosted fleet Machine: requests are scoped to the tenant namespace, so
  // installs land in <root>/tenants/<ns>. Ambient work (cron, channel-triggered
  // runs) has no request scope but serves the same single tenant — resolve the
  // same directory there, or a coder installed from the UI is "missing" for a
  // scheduled run.
  const scoped =
    getScopedUserId() ?? (env.FLEET_TENANT_ID?.trim() ? getGlobalUserId() : undefined);
  if (scoped && scoped !== DEFAULT_USER_ID) {
    return path.join(base, "tenants", safeSegment(scoped));
  }
  return base;
}

/** Shared shim directory — the one PATH entry for every managed coder. */
export function codersBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codersRoot(env), "bin");
}

/** Install prefix of one coder. `id` must be a catalog id (validated by callers). */
export function coderPrefix(id: CoderId, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid coder id: ${id}`);
  return path.join(codersRoot(env), id);
}

export function coderManifestPath(id: CoderId, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coderPrefix(id, env), ".install.json");
}

export function npmCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codersRoot(env), ".npm-cache");
}

/** True when `p` resolves inside `root` (guards every rm -rf). */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  if (rel === "" || path.isAbsolute(rel)) return false;
  // A segment named e.g. ".._x" is inside; only a real ".." component escapes.
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

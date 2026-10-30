/**
 * Production updater gateway methods (`update.prod.*`).
 *
 * The single shared entry point for the npm-install update path used by BOTH
 * the sidebar update widget and any Settings updater UI — there is no parallel
 * update code anywhere else. Dev/source checkouts keep using `update.auto.apply`
 * (which drives `update-runner.ts`); these methods serve published npm installs.
 *
 * Flow: update.prod.check → update.prod.preflight → update.prod.install.
 * Install progress is streamed to clients via `update.prod.progress` broadcast
 * events. We never auto-restart — the UI shows a "restart to apply" CTA.
 */

import {
  checkForUpdate,
  preflight,
  runInstall,
  invalidateCheckCache,
  installCommandLine,
  detectInstallManager,
  type InstallProgress,
} from "../../infra/prod-updater.js";
import { getFederationSatellite } from "../../federation/satellite.js";
import { isSatelliteMode } from "../../federation/satellite-context.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/** One install at a time, process-wide. */
let installInFlight = false;

function federationBlock(): {
  isSatellite: boolean;
  masterVersion: string | null;
  recommendedVersion: string | null;
} | null {
  if (!isSatelliteMode()) return null;
  const sat = getFederationSatellite();
  const masterVersion = sat?.getLastKnownMasterVersion?.() ?? null;
  return { isSatellite: true, masterVersion, recommendedVersion: masterVersion };
}

export const prodUpdateHandlers: GatewayRequestHandlers = {
  /**
   * Check the npm registry `latest` vs the running version. Cached 10 min;
   * pass { force: true } for "Check now" / sidebar-open refresh.
   */
  "update.prod.check": async ({ params, respond }) => {
    const force = (params as { force?: unknown }).force === true;
    const check = await checkForUpdate({ force });
    respond(true, { ...check, federation: federationBlock() }, undefined);
  },

  /**
   * Pre-flight the environment before an install: registry reachability,
   * write permission on the global node_modules dir, and free disk space.
   */
  "update.prod.preflight": async ({ respond }) => {
    const result = await preflight();
    respond(true, result, undefined);
  },

  /**
   * Run `npm install -g infinibot@<version>` (or the detected manager's
   * equivalent), streaming each output line to clients as
   * `update.prod.progress` events. Resolves with the final result; the
   * caller restarts manually.
   */
  "update.prod.install": async ({ params, respond, context }) => {
    if (installInFlight) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "an update install is already in progress"),
      );
      return;
    }

    const version =
      typeof (params as { version?: unknown }).version === "string"
        ? ((params as { version?: string }).version as string)
        : null;

    // Re-run preflight server-side as a hard gate — the UI preflight is
    // advisory; this is the authoritative check.
    const pre = await preflight();
    if (!pre.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, pre.hint ?? "preflight failed", {
          details: { preflight: pre },
        }),
      );
      return;
    }

    installInFlight = true;
    const installId = `upd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const commandLine = installCommandLine(detectInstallManager(), version ?? "latest");

    // Tell the client which stream to follow + the exact command we'll run.
    context.broadcast("update.prod.progress", {
      installId,
      kind: "start",
      commandLine,
      version: version ?? "latest",
    });

    try {
      const result = await runInstall({
        version,
        onProgress: (p: InstallProgress) => {
          context.broadcast(
            "update.prod.progress",
            { installId, ...p },
            { dropIfSlow: p.kind === "line" },
          );
        },
      });

      context.broadcast("update.prod.progress", {
        installId,
        kind: "end",
        ok: result.ok,
        exitCode: result.exitCode,
        errorKind: result.errorKind ?? null,
        hint: result.hint ?? null,
      });

      respond(true, { ...result, installId }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.broadcast("update.prod.progress", {
        installId,
        kind: "end",
        ok: false,
        errorKind: "unknown",
        hint: message,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, message, { details: { installId } }),
      );
    } finally {
      installInFlight = false;
    }
  },

  /** Drop the cached check result (debug / forced refresh helper). */
  "update.prod.invalidate": async ({ respond }) => {
    invalidateCheckCache();
    respond(true, { ok: true }, undefined);
  },
};

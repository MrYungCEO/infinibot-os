/**
 * `infinibot federation join <encoded-invite>` — satellite-side helper that
 * consumes a `FederationInvite` blob minted by a master, merges it into the
 * local config (atomically), and optionally restarts the gateway in satellite
 * mode.
 *
 * Pure-ish helper: `mergeInviteIntoConfig` has no I/O so it can be tested in
 * isolation. The thin imperative wrapper is `runJoinCommand`.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { decodeInvite, type FederationInvite } from "../../federation/invite.js";
import { formatMasterUrl } from "./satellite.js";

export interface MergeResult {
  next: InfinibotConfig;
  changedKeys: string[];
}

/**
 * Apply an invite to a config object. Returns a NEW config (does not mutate
 * the input). Pure — no I/O.
 */
export function mergeInviteIntoConfig(
  current: InfinibotConfig,
  invite: FederationInvite,
): MergeResult {
  const masterUrl = formatMasterUrl(invite.masterUrl);
  const satelliteId =
    invite.satelliteIdHint ?? current.federation?.nodeId ?? invite.satelliteToken.satelliteId;

  const nextFederation = {
    ...(current.federation ?? { mode: "satellite" as const }),
    enabled: true,
    mode: "satellite" as const,
    masterUrl,
    nodeId: satelliteId,
    // The satellite adopts the operator-chosen `satelliteName` from the invite.
    // We deliberately do NOT fall back to `invite.label` here: `label` carries
    // the MASTER's hub name, and using it was the bug that made every new
    // satellite show up under the master's device name. With no satelliteName
    // (older invites), keep whatever name the satellite already had.
    nodeName: invite.satelliteName ?? current.federation?.nodeName,
    // Stash invite details under a non-typed field so satellites can recover
    // them later without re-prompting. These are read by satellite startup
    // (see federation/satellite.ts) via the loose `authToken` slot.
    authToken: invite.satelliteToken,
    label: invite.label,
  } as InfinibotConfig["federation"];

  // We deliberately do NOT touch gateway.mode: the gateway schema only
  // accepts "local"|"remote", and federation.mode = "satellite" is the
  // canonical signal for satellite role (see shouldRunSatelliteMode).
  const next: InfinibotConfig = {
    ...current,
    federation: nextFederation,
  };

  return {
    next,
    changedKeys: [
      "federation.enabled",
      "federation.mode",
      "federation.masterUrl",
      "federation.nodeId",
      "federation.nodeName",
      "federation.authToken",
      "federation.label",
    ],
  };
}

export interface RunJoinOptions {
  encoded: string;
  yes?: boolean;
  configOnly?: boolean;
  noRestart?: boolean;
  /** Test seam: replace prompt + restart. */
  promptConfirm?: (msg: string) => Promise<boolean>;
  restartGateway?: () => Promise<void>;
  /** Test seam for config I/O. */
  loadConfigFn?: () => InfinibotConfig;
  writeConfigFn?: (cfg: InfinibotConfig) => Promise<void>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  stdinIsTTY?: boolean;
}

export interface RunJoinResult {
  invite: FederationInvite;
  config: InfinibotConfig;
  restarted: boolean;
}

export async function runJoinCommand(opts: RunJoinOptions): Promise<RunJoinResult> {
  const log = opts.log ?? ((m) => process.stdout.write(m + "\n"));
  const errFn = opts.error ?? ((m) => process.stderr.write(m + "\n"));
  const loader = opts.loadConfigFn ?? loadConfig;
  const writer = opts.writeConfigFn ?? writeConfigFile;
  const stdinTty = opts.stdinIsTTY ?? process.stdin.isTTY ?? false;

  const invite = decodeInvite(opts.encoded);
  const fp = (await import("../../federation/invite.js")).inviteFingerprint(invite);

  log(`Master: ${invite.iss} (${invite.masterUrl})`);
  log(`Fingerprint: ${fp}`);
  log(`Label: ${invite.label ?? "(none)"}`);

  if (!opts.yes) {
    if (!stdinTty) {
      errFn("Refusing to join without --yes when stdin is not a TTY.");
      throw new Error("non-tty without --yes");
    }
    const confirmFn =
      opts.promptConfirm ??
      (async () => {
        const { confirm, isCancel } = await import("@clack/prompts");
        const ok = await confirm({ message: "Accept invite and pair with this master?" });
        if (isCancel(ok)) return false;
        return Boolean(ok);
      });
    const ok = await confirmFn("Accept invite and pair with this master?");
    if (!ok) {
      errFn("Aborted.");
      throw new Error("user aborted");
    }
  }

  const current = loader();
  const merged = mergeInviteIntoConfig(current, invite);
  await writer(merged.next);
  log("Config updated. Satellite mode enabled.");

  let restarted = false;
  if (!opts.configOnly && !opts.noRestart) {
    const restartFn =
      opts.restartGateway ??
      (async () => {
        // Best-effort restart. If no gateway helper is available we just print
        // a hint — the watchdog / scheduled task on the host will pick the
        // change up on the next start.
        log("Run `infinibot gateway run` to start the satellite gateway.");
      });
    try {
      await restartFn();
      restarted = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errFn(`Warning: failed to restart gateway: ${msg}`);
    }
  }

  return { invite, config: merged.next, restarted };
}

/**
 * preAction shim: OPTIONAL Kingly Vault sign-in gate for CLI commands.
 *
 * Self-hosted / open-source installs never need a Kingly Vault account. The
 * gate is OFF by default and only applies when the operator explicitly opts in
 * with `INFINIBOT_REQUIRE_VAULT=1` (e.g. a commercial desktop build that ties
 * the install to a Vault account). With the gate off nothing here touches the
 * network — no request is made to kinglyvault.com.
 *
 * `INFINIBOT_DISABLE_AUTH=1` is kept for back-compat. It used to be the only
 * way past the gate; now it is redundant by default but still wins over
 * `INFINIBOT_REQUIRE_VAULT` so existing deployments that set it keep booting.
 *
 * When the gate is on, the allowlist below covers commands that must run
 * before the user has authenticated (login itself, the inverse logout,
 * identity probe, help/version, and read-only config introspection).
 */

import process from "node:process";

import { ensureValidToken } from "../../auth/guard.js";
import { NotAuthenticatedError } from "../../auth/errors.js";
import { VaultError } from "../../auth/vault-client.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { loadConfig } from "../../config/config.js";

/**
 * Top-level command paths that are exempt from the auth check. Each entry
 * is a list of positional tokens matched against the start of the parsed
 * commandPath; an empty entry [] matches the bare `infinibot` invocation
 * (which falls back to help).
 */
const AUTH_ALLOWLIST: ReadonlyArray<readonly string[]> = [
  [],
  ["login"],
  ["logout"],
  ["whoami"],
  ["version"],
  ["help"],
  ["config", "get"],
  ["config", "schema"],
  // Federation pairing is a separate trust mechanism (signed satellite token
  // from a master); a fresh satellite has to redeem the invite before it can
  // run anything else, so we allow `federation join` pre-auth. Minting an
  // invite (`federation invite`) is a master admin action and still requires
  // Vault auth.
  ["federation", "join"],
];

function isAllowlisted(commandPath: string[]): boolean {
  for (const allowed of AUTH_ALLOWLIST) {
    if (commandPath.length === 0 && allowed.length === 0) return true;
    if (allowed.length === 0) continue;
    let match = true;
    for (let i = 0; i < allowed.length; i += 1) {
      if (commandPath[i] !== allowed[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * A satellite node is authorized by its federation invite (a signed satellite
 * token from a master), not its own Vault login — the master holds the license
 * and governs the satellite's permissions. So a satellite gateway is allowed to
 * boot without a Vault token; otherwise an invite-joined node can never come
 * online (the gateway exits with "not signed in to Kingly Vault").
 */
function isSatelliteInstall(): boolean {
  try {
    const cfg = loadConfig();
    return cfg?.federation?.mode === "satellite" && Boolean(cfg?.federation?.authToken);
  } catch {
    return false;
  }
}

/**
 * Is the Kingly Vault sign-in gate enabled for this process? Only an explicit
 * `INFINIBOT_REQUIRE_VAULT=1` turns it on, and `INFINIBOT_DISABLE_AUTH=1`
 * (legacy) always turns it off.
 */
export function isVaultGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isTruthyEnvValue(env.INFINIBOT_DISABLE_AUTH)) return false;
  return isTruthyEnvValue(env.INFINIBOT_REQUIRE_VAULT);
}

export async function ensureVaultAuth(commandPath: string[]): Promise<void> {
  if (!isVaultGateEnabled()) return;
  if (isAllowlisted(commandPath)) return;
  // Satellite gateways boot on their federation token alone (see above).
  if (commandPath[0] === "gateway" && isSatelliteInstall()) return;
  try {
    await ensureValidToken();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      process.stderr.write(
        "This installation isn't signed in to Kingly Vault.\nRun: infinibot login\n",
      );
      process.exit(1);
      return;
    }
    // A server-side Vault failure (egress/spend-cap quota, 5xx, network) is NOT
    // an auth rejection — the stored credentials are still valid, the Vault is
    // just unreachable or restricted. Hard-exiting here would take the gateway
    // offline for a billing problem we can't fix locally, so we warn and
    // continue on the existing token instead of aborting startup.
    const temporaryNetworkFailure =
      err instanceof TypeError && /fetch failed|network|socket|timed? ?out/i.test(err.message);
    if (err instanceof VaultError || temporaryNetworkFailure) {
      const code = err instanceof VaultError ? err.code : "network_unavailable";
      process.stderr.write(
        `[auth] Vault unavailable (${code}): ${err.message}\n` +
          "[auth] Continuing on stored credentials — refresh/validation was skipped.\n",
      );
      return;
    }
    throw err;
  }
}

/** Exposed for tests. */
export const __AUTH_ALLOWLIST_FOR_TESTS = AUTH_ALLOWLIST;

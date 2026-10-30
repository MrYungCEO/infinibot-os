/**
 * `infinibot logout` — revokes the current Vault token (best-effort) and
 * clears the local bundle. Network failures during revoke are intentionally
 * swallowed: a stale bundle on disk is worse than a stale token on the
 * server.
 */

import type { Command } from "commander";

import { clearAuth, loadAuth } from "../../auth/token-store.js";
import { revokeToken } from "../../auth/vault-client.js";

export async function runLogout(): Promise<void> {
  const stored = await loadAuth();
  if (stored?.access_token) {
    try {
      await revokeToken(stored.access_token, { baseUrl: stored.vault_url });
    } catch {
      // Best-effort: ignore network / server errors.
    }
  }
  await clearAuth();
  process.stdout.write("Signed out.\n");
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Revoke the current Kingly Vault token and clear the local bundle")
    .action(async () => {
      await runLogout();
    });
}

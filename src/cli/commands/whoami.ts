/**
 * `infinibot whoami` — prints the identity carried by the locally stored
 * Vault token, including expiry and the URL we authenticated against.
 */

import type { Command } from "commander";

import { ensureValidToken } from "../../auth/guard.js";
import { NotAuthenticatedError } from "../../auth/errors.js";

export async function runWhoami(): Promise<void> {
  try {
    const stored = await ensureValidToken();
    const lines = [
      `tenant_id:  ${stored.tenant_id || "(env-token)"}`,
      `scopes:     ${stored.scopes.join(", ") || "(none)"}`,
      `expires_at: ${new Date(stored.expires_at).toISOString()}`,
      `vault_url:  ${stored.vault_url}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      process.stderr.write(
        "This installation isn't signed in to Kingly Vault.\nRun: infinibot login\n",
      );
      process.exit(1);
    }
    throw err;
  }
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show identity and scopes for the stored Vault token")
    .action(async () => {
      await runWhoami();
    });
}

/**
 * `infinibot login` — kicks off the OAuth 2.0 device authorization flow
 * against Kingly Vault and stores the resulting bundle. Safe to re-run;
 * subsequent logins overwrite the previous bundle in place.
 */

import os from "node:os";
import type { Command } from "commander";

import { DEFAULT_VAULT_SCOPES } from "../../auth/vault-client.js";
import { DeviceDeniedError, TokenExpiredError } from "../../auth/errors.js";
import { loginInteractive } from "../../auth/device-flow.js";

type LoginOpts = { scope?: string[]; label?: string };

export async function runLogin(opts: LoginOpts = {}): Promise<void> {
  const scopes = opts.scope && opts.scope.length > 0 ? opts.scope : [...DEFAULT_VAULT_SCOPES];
  const deviceLabel = opts.label ?? os.hostname();
  try {
    const stored = await loginInteractive({ scopes, deviceLabel });
    process.stdout.write(`Signed in as ${stored.tenant_id}. Token stored.\n`);
  } catch (err) {
    if (err instanceof DeviceDeniedError) {
      process.stderr.write("Authorization denied.\n");
      process.exit(1);
    }
    if (err instanceof TokenExpiredError) {
      process.stderr.write("Device code expired before approval. Run `infinibot login` again.\n");
      process.exit(1);
    }
    throw err;
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in to Kingly Vault via OAuth 2.0 device authorization")
    .option("--scope <scope...>", "Scope(s) to request (default: gateway mesh federation)")
    .option("--label <label>", "Human-readable device label", os.hostname())
    .action(async (opts: LoginOpts) => {
      await runLogin(opts);
    });
}

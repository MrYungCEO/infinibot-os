import type { Command } from "commander";
import { setupUiCommand, type SetupUiOptions } from "../../commands/setup-ui.js";
import { theme } from "../../terminal/theme.js";

/**
 * Register `infinibot quickstart` — kept as a back-compat alias for the new
 * `infinibot setup-ui` command. Older muscle memory and docs still reach
 * for "quickstart"; we route both to the same standalone setup server so
 * the user gets the same reliable experience either way.
 *
 * The old behaviour (spawn a gateway in unconfigured mode and serve the
 * wizard inside it) is gone. That path was a chicken-and-egg trap: the
 * gateway needs auth to accept connections, but the wizard exists to set
 * that auth, and any restart-during-setup killed the parent CLI. The new
 * path doesn't need a gateway at all during setup.
 */
export function registerQuickstartCommand(program: Command): void {
  program
    .command("quickstart")
    .description("Open a guided web setup for InfiniBot (alias for `infinibot setup-ui`)")
    .option("--no-open", "Do not auto-open the browser; just print the URL")
    .option("--port <number>", "Port to bind to on 127.0.0.1 (default: 18790)")
    // Kept (but ignored) for back-compat with older scripts/docs that still
    // pass these flags. They were meaningful only for the old gateway-spawn
    // path; the standalone server has no bind/auth-mode of its own.
    .option("--bind <mode>", "(deprecated, ignored)")
    .action(async (raw) => {
      const opts: SetupUiOptions = {
        noOpen: raw.open === false,
        port: raw.port ? Number(raw.port) : undefined,
      };
      try {
        await setupUiCommand(opts);
      } catch (err) {
        console.error(theme.error(`Quickstart failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}

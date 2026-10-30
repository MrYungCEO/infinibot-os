/**
 * Registers `infinibot setup-ui` — the standalone setup wizard launcher.
 * See src/commands/setup-ui.ts for the lifecycle.
 */
import type { Command } from "commander";

import { setupUiCommand, type SetupUiOptions } from "../../commands/setup-ui.js";
import { theme } from "../../terminal/theme.js";

export function registerSetupUiCommand(program: Command): void {
  program
    .command("setup-ui")
    .description(
      "Open a guided web setup for InfiniBot — runs without a gateway, writes config directly",
    )
    .option("--no-open", "Do not auto-open the browser; just print the URL")
    .option("--port <number>", "Port to bind to on 127.0.0.1 (default: 18790)")
    .action(async (raw) => {
      const opts: SetupUiOptions = {
        noOpen: raw.open === false,
        port: raw.port ? Number(raw.port) : undefined,
      };
      try {
        await setupUiCommand(opts);
      } catch (err) {
        console.error(theme.error(`setup-ui failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}

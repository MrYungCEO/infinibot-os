import type { Command } from "commander";

import { backupCommand, restoreCommand } from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerBackupCommands(program: Command) {
  program
    .command("backup")
    .description(
      "Bundle config, databases, credentials, and the agent workspace into a single .zip",
    )
    .option("-o, --out <path>", "Output zip path (default: ./infinibot-backup-<timestamp>.zip)")
    .option("--workspace <dir>", "Override agent workspace dir to back up")
    .option("--skip-workspace", "Exclude the agent workspace from the backup", false)
    .option("--json", "Print a JSON summary", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCommand(
          {
            out: opts.out as string | undefined,
            workspace: opts.workspace as string | undefined,
            skipWorkspace: Boolean(opts.skipWorkspace),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  program
    .command("restore <zip>")
    .description("Restore a backup zip produced by `infinibot backup` into this install")
    .option("--force", "Rotate any existing state/workspace dirs to .bak-* and overwrite", false)
    .option("--skip-workspace", "Do not restore the agent workspace dir", false)
    .option(
      "--workspace <dir>",
      "Override workspace target dir (default: as recorded in the backup)",
    )
    .option("--inspect", "Print the backup manifest without restoring", false)
    .option("--json", "Print a JSON summary", false)
    .action(async (zip: string, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await restoreCommand(
          {
            zip,
            force: Boolean(opts.force),
            skipWorkspace: Boolean(opts.skipWorkspace),
            workspace: opts.workspace as string | undefined,
            inspect: Boolean(opts.inspect),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}

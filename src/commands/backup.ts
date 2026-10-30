import path from "node:path";

import {
  createBackup,
  defaultBackupFilename,
  readBackupManifest,
  restoreBackup,
} from "../infra/backup.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

export type BackupCommandOptions = {
  out?: string;
  workspace?: string;
  skipWorkspace?: boolean;
  json?: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function backupCommand(
  opts: BackupCommandOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const outPath = path.resolve(opts.out ?? path.join(process.cwd(), defaultBackupFilename()));
  const result = await createBackup({
    outPath,
    includeWorkspace: !opts.skipWorkspace,
    workspaceDir: opts.workspace,
    logger: {
      info: (msg) => runtime.error(msg),
      warn: (msg) => runtime.error(msg),
    },
  });
  if (opts.json) {
    runtime.error(JSON.stringify(result, null, 2));
    return;
  }
  runtime.error(
    `Backup written: ${shortenHomePath(result.zipPath)} (${formatBytes(result.bytes)}, ${result.fileCount} files)`,
  );
  runtime.error(`  shared: ${shortenHomePath(result.manifest.sharedDirSource)}`);
  if (result.manifest.hasUserSubtree) {
    runtime.error(
      `  user (${result.manifest.userId}): ${shortenHomePath(result.manifest.stateDirSource)}`,
    );
  }
  if (result.manifest.hasWorkspace && result.manifest.workspaceDirSource) {
    runtime.error(`  workspace: ${shortenHomePath(result.manifest.workspaceDirSource)}`);
  }
}

export type RestoreCommandOptions = {
  zip: string;
  force?: boolean;
  skipWorkspace?: boolean;
  workspace?: string;
  inspect?: boolean;
  json?: boolean;
};

export async function restoreCommand(
  opts: RestoreCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const zipPath = path.resolve(opts.zip);
  if (opts.inspect) {
    const manifest = await readBackupManifest(zipPath);
    if (opts.json) {
      runtime.error(JSON.stringify(manifest, null, 2));
      return;
    }
    runtime.error(`Backup: ${shortenHomePath(zipPath)}`);
    runtime.error(`  created:    ${manifest.createdAt}`);
    runtime.error(`  version:    ${manifest.infinibotVersion ?? "unknown"}`);
    runtime.error(`  user:       ${manifest.userId}`);
    runtime.error(`  hostname:   ${manifest.hostname}`);
    runtime.error(`  platform:   ${manifest.platform}`);
    runtime.error(`  shared:     ${shortenHomePath(manifest.sharedDirSource)}`);
    if (manifest.hasUserSubtree) {
      runtime.error(`  state:      ${shortenHomePath(manifest.stateDirSource)}`);
    }
    if (manifest.hasWorkspace && manifest.workspaceDirSource) {
      runtime.error(`  workspace:  ${shortenHomePath(manifest.workspaceDirSource)}`);
    }
    return;
  }

  const result = await restoreBackup({
    zipPath,
    force: opts.force,
    skipWorkspace: opts.skipWorkspace,
    workspaceDir: opts.workspace,
    logger: {
      info: (msg) => runtime.error(msg),
      warn: (msg) => runtime.error(msg),
    },
  });
  if (opts.json) {
    runtime.error(JSON.stringify(result, null, 2));
    return;
  }
  runtime.error(`Restore complete from ${shortenHomePath(zipPath)}.`);
  runtime.error(`  shared:    ${shortenHomePath(result.targets.sharedDir)}`);
  if (result.targets.stateDir !== result.targets.sharedDir) {
    runtime.error(`  state:     ${shortenHomePath(result.targets.stateDir)}`);
  }
  if (result.targets.workspaceDir) {
    runtime.error(`  workspace: ${shortenHomePath(result.targets.workspaceDir)}`);
  }
  if (result.rotated.length > 0) {
    runtime.error(`Rotated pre-existing dirs (delete once you've verified):`);
    for (const p of result.rotated) runtime.error(`  - ${shortenHomePath(p)}`);
  }
  runtime.error(
    `\nNext: start the gateway with \`infinibot daemon start\` (or \`infinibot status\`) to verify.`,
  );
}

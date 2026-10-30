#!/usr/bin/env node

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { sync, syncDryRun, statusTable, type CodeSyncConfig } from "../src/federation/code-sync.js";

function findRepoRoot(): string | undefined {
  let dir = resolve(process.cwd());
  const root = resolve("/");
  while (dir.length >= root.length) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      "dry-run": { type: "boolean", short: "n", default: false },
      remote: { type: "string", short: "r" },
      branch: { type: "string", short: "b" },
      role: { type: "string", short: "R" },
      repo: { type: "string", short: "p" },
      status: { type: "boolean", short: "s", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
federation-sync — Sync code changes across federation devices via GitHub

USAGE:
  federation-sync [options] [command]

COMMANDS:
  sync       Run a full sync cycle (fetch, pull, push) — default
  status     Show sync status table

OPTIONS:
  -n, --dry-run    Show what would happen without making changes
  -r, --remote     Git remote to sync with (default: origin)
  -b, --branch     Branch to sync (default: main)
  -R, --role       Device role: master | satellite (default: master)
  -p, --repo       Path to git repository (default: auto-detect)
  -s, --status     Alias for 'status' command
  -h, --help       Show this help

EXAMPLES:
  federation-sync status
  federation-sync sync
  federation-sync sync --dry-run
  federation-sync sync --remote origin --branch main
  federation-sync sync --role satellite

ENVIRONMENT:
  FEDERATION_REPO_PATH   Repository path (alternative to --repo)
  FEDERATION_GIT_REMOTE  Git remote name (alternative to --remote)
  FEDERATION_GIT_BRANCH  Git branch name (alternative to --branch)
  FEDERATION_ROLE        Device role: master | satellite
  FEDERATION_NODE_ID     Federation node ID for metadata
`);
    process.exit(0);
  }

  const repoPath = values.repo || findRepoRoot();
  if (!repoPath) {
    console.error("Error: Cannot find repo root. Specify with --repo or FEDERATION_REPO_PATH");
    process.exit(1);
  }

  const cfg: CodeSyncConfig = {
    repoPath,
    remote: values.remote,
    branch: values.branch,
  };
  if (values.role) cfg.role = values.role as "master" | "satellite";

  const command = positionals[0] || (values.status ? "status" : "sync");

  if (command === "status") {
    console.log(statusTable(cfg));
    process.exit(0);
  }

  if (command === "sync") {
    if (values["dry-run"]) {
      const result = syncDryRun(cfg);
      console.log(`Action:  ${result.action}`);
      console.log(`Message: ${result.message}`);
      if (result.aheadBefore > 0) console.log(`Ahead:   ${result.aheadBefore} commit(s)`);
      if (result.behindBefore > 0) console.log(`Behind:  ${result.behindBefore} commit(s)`);
      if (!result.ok) console.log(`Error:   ${result.error || result.message}`);
      process.exit(result.ok ? 0 : 1);
    }

    console.log("Running federation sync...");
    const result = sync(cfg);
    console.log(`Action:  ${result.action}`);
    console.log(`Before:  ${result.beforeCommit.slice(0, 12)}`);
    console.log(`After:   ${result.afterCommit.slice(0, 12)}`);
    console.log(`Message: ${result.message}`);
    if (!result.ok) {
      console.error(`Error:   ${result.error || result.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command}. Use --help for usage.`);
  process.exit(1);
}

main();
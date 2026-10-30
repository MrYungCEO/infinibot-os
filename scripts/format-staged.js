import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OXFMT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

function getRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function runGitCommand(args, options = {}) {
  return spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: options.stdio ?? "pipe",
  });
}

function splitNullDelimited(value) {
  if (!value) return [];
  const text = String(value);
  return text.split("\0").filter(Boolean);
}

function normalizeGitPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function filterOxfmtTargets(paths) {
  return paths
    .map(normalizeGitPath)
    .filter((filePath) =>
      (filePath.startsWith("src/") || filePath.startsWith("test/")) &&
      OXFMT_EXTENSIONS.has(path.posix.extname(filePath)),
    );
}

function findPartiallyStagedFiles(stagedFiles, unstagedFiles) {
  const unstaged = new Set(unstagedFiles.map(normalizeGitPath));
  return stagedFiles.filter((filePath) => unstaged.has(normalizeGitPath(filePath)));
}

function filterOutPartialTargets(targets, partialTargets) {
  if (partialTargets.length === 0) return targets;
  const partial = new Set(partialTargets.map(normalizeGitPath));
  return targets.filter((filePath) => !partial.has(normalizeGitPath(filePath)));
}

function resolveOxfmtCommand(repoRoot) {
  const binName = process.platform === "win32" ? "oxfmt.cmd" : "oxfmt";
  const local = path.join(repoRoot, "node_modules", ".bin", binName);
  if (fs.existsSync(local)) {
    return { command: local, args: [] };
  }

  const result = spawnSync("oxfmt", ["--version"], { stdio: "ignore" });
  if (result.status === 0) {
    return { command: "oxfmt", args: [] };
  }

  return null;
}

function getGitPaths(args, repoRoot) {
  const result = runGitCommand(args, { cwd: repoRoot });
  if (result.status !== 0) return [];
  return splitNullDelimited(result.stdout ?? "");
}

// Windows caps a command line at ~8K chars; a big merge can stage hundreds
// of files, so every spawn that takes a file list must run in batches.
function chunkFiles(files, size = 50) {
  const batches = [];
  for (let i = 0; i < files.length; i += size) {
    batches.push(files.slice(i, i + size));
  }
  return batches;
}

function formatFiles(repoRoot, oxfmt, files) {
  for (const batch of chunkFiles(files)) {
    const result = spawnSync(oxfmt.command, ["--write", ...oxfmt.args, ...batch], {
      cwd: repoRoot,
      stdio: "inherit",
      // On Windows, oxfmt resolves to `oxfmt.cmd`; spawnSync needs shell:true
      // to launch .cmd files. Without it, status is null and the hook fails
      // silently with exit 1, which is impossible to debug from the commit
      // path. POSIX shells just ignore the flag.
      shell: process.platform === "win32",
    });
    if (result.status !== 0) return false;
  }
  return true;
}

function stageFiles(repoRoot, files) {
  for (const batch of chunkFiles(files)) {
    const result = runGitCommand(["add", "--", ...batch], { cwd: repoRoot, stdio: "inherit" });
    if (result.status !== 0) return false;
  }
  return true;
}

function main() {
  const repoRoot = getRepoRoot();
  const staged = getGitPaths([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--diff-filter=ACMR",
  ], repoRoot);
  const targets = filterOxfmtTargets(staged);
  if (targets.length === 0) return;

  const unstaged = getGitPaths(["diff", "--name-only", "-z"], repoRoot);
  const partial = findPartiallyStagedFiles(targets, unstaged);
  if (partial.length > 0) {
    process.stderr.write("[pre-commit] Skipping partially staged files:\n");
    for (const filePath of partial) {
      process.stderr.write(`- ${filePath}\n`);
    }
    process.stderr.write("Stage full files to format them automatically.\n");
  }

  const filteredTargets = filterOutPartialTargets(targets, partial);
  if (filteredTargets.length === 0) return;

  const oxfmt = resolveOxfmtCommand(repoRoot);
  if (!oxfmt) {
    process.stderr.write("[pre-commit] oxfmt not found; skipping format.\n");
    return;
  }

  if (!formatFiles(repoRoot, oxfmt, filteredTargets)) {
    process.exitCode = 1;
    return;
  }

  if (!stageFiles(repoRoot, filteredTargets)) {
    process.exitCode = 1;
  }
}

export {
  filterOxfmtTargets,
  filterOutPartialTargets,
  findPartiallyStagedFiles,
  getRepoRoot,
  normalizeGitPath,
  resolveOxfmtCommand,
  splitNullDelimited,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

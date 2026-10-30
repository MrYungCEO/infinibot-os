import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveStateDir } from "../config/paths.js";

export type WorkspaceVersion = {
  id: string;
  directoryId: string;
  commit: string;
  baseHead: string;
  description: string;
  createdAt: number;
  stats: string;
};

function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  encoding: BufferEncoding | "buffer" = "utf8",
): string | Buffer {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: encoding === "buffer" ? null : encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function metadataFile(directoryId: string): string {
  return path.join(
    resolveStateDir(),
    "workspace-versions",
    `${directoryId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`,
  );
}

function readVersions(directoryId: string): WorkspaceVersion[] {
  try {
    return JSON.parse(fs.readFileSync(metadataFile(directoryId), "utf8")) as WorkspaceVersion[];
  } catch {
    return [];
  }
}

function writeVersions(directoryId: string, versions: WorkspaceVersion[]): void {
  const file = metadataFile(directoryId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(versions.slice(0, 50), null, 2));
}

function snapshotCommit(cwd: string, message: string): { commit: string; head: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-workspace-index-"));
  const index = path.join(tempDir, "index");
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "InfiniBot Workspace",
    GIT_AUTHOR_EMAIL: "workspace@infinibot.local",
    GIT_COMMITTER_NAME: "InfiniBot Workspace",
    GIT_COMMITTER_EMAIL: "workspace@infinibot.local",
  };
  try {
    const head = String(git(cwd, ["rev-parse", "HEAD"])).trim();
    git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "-A"], env);
    const tree = String(git(cwd, ["write-tree"], env)).trim();
    const commit = String(git(cwd, ["commit-tree", tree, "-p", head, "-m", message], env)).trim();
    return { commit, head };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createWorkspaceVersion(
  cwd: string,
  directoryId: string,
  description: string,
): WorkspaceVersion {
  const { commit, head } = snapshotCommit(cwd, description);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  git(cwd, [
    "update-ref",
    `refs/infinibot/workspace/${directoryId.replace(/[^a-zA-Z0-9_/-]/g, "_")}/${id}`,
    commit,
  ]);
  const stats = String(git(cwd, ["diff", "--stat", head, commit, "--"])).trim();
  const version = {
    id,
    directoryId,
    commit,
    baseHead: head,
    description,
    createdAt: Date.now(),
    stats,
  };
  writeVersions(directoryId, [version, ...readVersions(directoryId)]);
  return version;
}

export function listWorkspaceVersions(directoryId: string): WorkspaceVersion[] {
  return readVersions(directoryId);
}

export function diffWorkspaceVersion(
  cwd: string,
  directoryId: string,
  versionId: string,
): { version: WorkspaceVersion; diff: string } {
  const version = readVersions(directoryId).find((item) => item.id === versionId);
  if (!version) throw new Error("Workspace version not found");
  // A workspace checkpoint is created immediately before an agent turn. Its
  // useful diff is therefore checkpoint → current working tree, including
  // dirty and untracked files, rather than HEAD → checkpoint. Snapshot the
  // current tree into an unattached commit so the user's HEAD and index stay
  // untouched while the UI gets the actual turn delta.
  const current = snapshotCommit(cwd, "Workspace diff preview");
  const diff = String(
    git(cwd, ["diff", "--no-ext-diff", "--unified=3", version.commit, current.commit, "--"]),
  );
  return { version, diff: diff.slice(0, 1_000_000) };
}

export function revertWorkspaceVersion(
  cwd: string,
  directoryId: string,
  versionId: string,
): WorkspaceVersion {
  const version = readVersions(directoryId).find((item) => item.id === versionId);
  if (!version) throw new Error("Workspace version not found");
  // Keep the state being replaced as a normal, listed checkpoint. This makes
  // the one-click revert itself reversible without moving HEAD or the user's
  // real index.
  const backup = createWorkspaceVersion(
    cwd,
    directoryId,
    `Before reverting to ${version.description}`,
  );
  const patch = git(
    cwd,
    ["diff", "--binary", backup.commit, version.commit, "--"],
    undefined,
    "buffer",
  ) as Buffer;
  if (patch.length) {
    execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
      cwd,
      input: patch,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return version;
}

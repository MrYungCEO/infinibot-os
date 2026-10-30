import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname, platform, release } from "node:os";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation").child("code-sync");

const SYNC_META_FILE = ".federation-sync.json";
const FEDERATION_LOG_DIR = "logs/federation-audit";

export interface SyncDeviceMeta {
  hostname: string;
  role: "master" | "satellite";
  platform: string;
  release: string;
  nodeId?: string;
  lastSyncCommit: string;
  lastSyncTimestamp: number;
}

export interface SyncStatus {
  ok: boolean;
  currentBranch: string;
  currentCommit: string;
  remote: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
  uncommittedFiles: number;
  deviceMeta: SyncDeviceMeta;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  action: "push" | "pull" | "noop" | "conflict" | "error";
  beforeCommit: string;
  afterCommit: string;
  aheadBefore: number;
  behindBefore: number;
  message: string;
  error?: string;
}

export interface CodeSyncConfig {
  remote?: string;
  branch?: string;
  repoPath?: string;
  role?: "master" | "satellite";
}

function git(args: string, repoPath?: string): string {
  const cwd = repoPath || process.cwd();
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

function gitSafe(args: string, repoPath?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const cwd = repoPath || process.cwd();
    const stdout = execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || err.message };
  }
}

function getRepoPath(repoPath?: string): string {
  if (repoPath) return repoPath;
  return process.env.FEDERATION_REPO_PATH || process.cwd();
}

function getRemote(cfg?: CodeSyncConfig): string {
  return cfg?.remote || process.env.FEDERATION_GIT_REMOTE || "origin";
}

function getBranch(cfg?: CodeSyncConfig): string {
  return cfg?.branch || process.env.FEDERATION_GIT_BRANCH || "main";
}

function getRole(cfg?: CodeSyncConfig): "master" | "satellite" {
  if (cfg?.role) return cfg.role;
  if (process.env.FEDERATION_ROLE === "satellite") return "satellite";
  return "master";
}

export function h(): string {
  return hostname();
}

export function getPlatformLabel(): string {
  const p = platform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

function logPath(): string {
  const d = new Date().toISOString().slice(0, 10);
  const rp = process.env.FEDERATION_REPO_PATH || process.cwd();
  return join(rp, FEDERATION_LOG_DIR, `code-sync-${d}.log`);
}

async function appendLog(entry: Record<string, unknown>): Promise<void> {
  const fp = logPath();
  await mkdir(dirname(fp), { recursive: true });
  await appendFile(fp, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n", "utf-8");
}

function readSyncMeta(repoPath?: string): SyncDeviceMeta | null {
  const fp = join(getRepoPath(repoPath), SYNC_META_FILE);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, "utf-8")) as SyncDeviceMeta;
  } catch {
    return null;
  }
}

function writeSyncMeta(meta: SyncDeviceMeta): void {
  const fp = join(getRepoPath(), SYNC_META_FILE);
  writeFileSync(fp, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

function getCurrentBranch(repoPath?: string): string {
  return git("rev-parse --abbrev-ref HEAD", repoPath);
}

function getCurrentCommit(repoPath?: string): string {
  return git("rev-parse HEAD", repoPath);
}

function getAheadBehind(
  remote: string,
  branch: string,
  repoPath?: string,
): { ahead: number; behind: number } {
  const r = gitSafe(`rev-list --count --left-right ${remote}/${branch}...HEAD`, repoPath);
  if (!r.ok) return { ahead: 0, behind: 0 };
  const parts = r.stdout.split("\t");
  const ahead = parseInt(parts[0] || "0", 10);
  const behind = parseInt(parts[1] || "0", 10);
  return { ahead: isNaN(ahead) ? 0 : ahead, behind: isNaN(behind) ? 0 : behind };
}

function hasUncommitted(repoPath?: string): { has: boolean; count: number } {
  const s = gitSafe("status --porcelain", repoPath);
  if (!s.ok) return { has: false, count: 0 };
  const lines = s.stdout.split("\n").filter(Boolean);
  return { has: lines.length > 0, count: lines.length };
}

function fetchRemote(remote: string, repoPath?: string): boolean {
  const r = gitSafe(`fetch ${remote}`, repoPath);
  return r.ok;
}

export function getStatus(cfg?: CodeSyncConfig): SyncStatus {
  const rp = getRepoPath(cfg?.repoPath);
  const remote = getRemote(cfg);
  const branch = getBranch(cfg);

  fetchRemote(remote, rp);

  const curBranch = getCurrentBranch(rp);
  const curCommit = getCurrentCommit(rp);
  const ab = getAheadBehind(remote, branch, rp);
  const uc = hasUncommitted(rp);

  const meta: SyncDeviceMeta = {
    hostname: h(),
    role: getRole(cfg),
    platform: getPlatformLabel(),
    release: release(),
    nodeId: process.env.FEDERATION_NODE_ID,
    lastSyncCommit: curCommit,
    lastSyncTimestamp: Date.now(),
  };

  return {
    ok: true,
    currentBranch: curBranch,
    currentCommit: curCommit,
    remote,
    ahead: ab.ahead,
    behind: ab.behind,
    hasUncommitted: uc.has,
    uncommittedFiles: uc.count,
    deviceMeta: meta,
  };
}

export function sync(cfg?: CodeSyncConfig): SyncResult {
  const rp = getRepoPath(cfg?.repoPath);
  const remote = getRemote(cfg);
  const branch = getBranch(cfg);
  const role = getRole(cfg);

  const before = getCurrentCommit(rp);
  const abBefore = getAheadBehind(remote, branch, rp);
  const uc = hasUncommitted(rp);

  log.info(`sync start: role=${role} remote=${remote} branch=${branch} host=${h()}`);

  void appendLog({
    event: "sync.start",
    role,
    remote,
    branch,
    hostname: h(),
    platform: getPlatformLabel(),
    beforeCommit: before,
    aheadBefore: abBefore.ahead,
    behindBefore: abBefore.behind,
    hasUncommitted: uc.has,
    uncommittedCount: uc.count,
  });

  if (!fetchRemote(remote, rp)) {
    const result: SyncResult = {
      ok: false,
      action: "error",
      beforeCommit: before,
      afterCommit: before,
      aheadBefore: abBefore.ahead,
      behindBefore: abBefore.behind,
      message: "Failed to fetch from remote",
    };
    void appendLog({ event: "sync.error", error: result.message });
    return result;
  }

  const abAfter = getAheadBehind(remote, branch, rp);

  if (abAfter.behind > 0) {
    if (uc.has) {
      log.warn(`Uncommitted changes (${uc.count} files) — cannot pull cleanly`);
      const result: SyncResult = {
        ok: false,
        action: "conflict",
        beforeCommit: before,
        afterCommit: before,
        aheadBefore: abAfter.ahead,
        behindBefore: abAfter.behind,
        message: `Cannot pull: ${uc.count} uncommitted file(s). Commit or stash first.`,
      };
      void appendLog({ event: "sync.conflict", ...result });
      return result;
    }

    const pull = gitSafe(`pull --ff-only ${remote} ${branch}`, rp);
    if (!pull.ok) {
      const result: SyncResult = {
        ok: false,
        action: "conflict",
        beforeCommit: before,
        afterCommit: getCurrentCommit(rp),
        aheadBefore: abAfter.ahead,
        behindBefore: abAfter.behind,
        message: pull.stderr || pull.stdout,
        error: pull.stderr,
      };
      void appendLog({ event: "sync.conflict", ...result });
      return result;
    }

    const afterPull = getCurrentCommit(rp);
    log.info(`pulled ${remote}/${branch}: ${before.slice(0, 8)}..${afterPull.slice(0, 8)}`);

    const result: SyncResult = {
      ok: true,
      action: "pull",
      beforeCommit: before,
      afterCommit: afterPull,
      aheadBefore: abAfter.ahead,
      behindBefore: abAfter.behind,
      message: `Pulled ${abAfter.behind} commit(s) from ${remote}/${branch}`,
    };

    writeSyncMeta({
      hostname: h(),
      role,
      platform: getPlatformLabel(),
      release: release(),
      lastSyncCommit: afterPull,
      lastSyncTimestamp: Date.now(),
    });

    void appendLog({ event: "sync.pull", ...result });
    return result;
  }

  if (abAfter.ahead > 0) {
    const push = gitSafe(`push ${remote} ${branch}`, rp);
    if (!push.ok) {
      const result: SyncResult = {
        ok: false,
        action: "error",
        beforeCommit: before,
        afterCommit: before,
        aheadBefore: abAfter.ahead,
        behindBefore: abAfter.behind,
        message: push.stderr || push.stdout,
        error: push.stderr,
      };
      void appendLog({ event: "sync.error", ...result });
      return result;
    }

    log.info(`pushed ${abAfter.ahead} commit(s) to ${remote}/${branch}`);

    const result: SyncResult = {
      ok: true,
      action: "push",
      beforeCommit: before,
      afterCommit: before,
      aheadBefore: abAfter.ahead,
      behindBefore: abAfter.behind,
      message: `Pushed ${abAfter.ahead} commit(s) to ${remote}/${branch}`,
    };

    writeSyncMeta({
      hostname: h(),
      role,
      platform: getPlatformLabel(),
      release: release(),
      lastSyncCommit: before,
      lastSyncTimestamp: Date.now(),
    });

    void appendLog({ event: "sync.push", ...result });
    return result;
  }

  writeSyncMeta({
    hostname: h(),
    role,
    platform: getPlatformLabel(),
    release: release(),
    lastSyncCommit: before,
    lastSyncTimestamp: Date.now(),
  });

  void appendLog({ event: "sync.noop", beforeCommit: before });

  return {
    ok: true,
    action: "noop",
    beforeCommit: before,
    afterCommit: before,
    aheadBefore: 0,
    behindBefore: 0,
    message: "Already in sync",
  };
}

export function syncDryRun(cfg?: CodeSyncConfig): SyncResult {
  const rp = getRepoPath(cfg?.repoPath);
  const remote = getRemote(cfg);
  const branch = getBranch(cfg);
  const role = getRole(cfg);

  const before = getCurrentCommit(rp);
  fetchRemote(remote, rp);
  const ab = getAheadBehind(remote, branch, rp);
  const uc = hasUncommitted(rp);

  let action: SyncResult["action"] = "noop";
  let message = "Already in sync";

  if (uc.has && ab.behind > 0) {
    action = "conflict";
    message = `DRY-RUN: Would need to commit/stash ${uc.count} file(s) before pulling ${ab.behind} commit(s)`;
  } else if (ab.behind > 0) {
    action = "pull";
    message = `DRY-RUN: Would pull ${ab.behind} commit(s) from ${remote}/${branch}`;
  } else if (ab.ahead > 0) {
    action = "push";
    message = `DRY-RUN: Would push ${ab.ahead} commit(s) to ${remote}/${branch}`;
  }

  return {
    ok: true,
    action,
    beforeCommit: before,
    afterCommit: before,
    aheadBefore: ab.ahead,
    behindBefore: ab.behind,
    message,
  };
}

export function statusTable(cfg?: CodeSyncConfig): string {
  const s = getStatus(cfg);
  const lines: string[] = [];
  lines.push("Federation Code Sync Status");
  lines.push("=".repeat(50));
  lines.push(`  Hostname:        ${s.deviceMeta.hostname}`);
  lines.push(`  Role:            ${s.deviceMeta.role}`);
  lines.push(`  Platform:        ${s.deviceMeta.platform}`);
  lines.push(`  Branch:          ${s.currentBranch}`);
  lines.push(`  HEAD:            ${s.currentCommit.slice(0, 12)}`);
  lines.push(`  Remote:          ${s.remote}`);
  lines.push(`  Ahead:           ${s.ahead}`);
  lines.push(`  Behind:          ${s.behind}`);
  lines.push(`  Uncommitted:     ${s.hasUncommitted ? `${s.uncommittedFiles} file(s)` : "clean"}`);
  const meta = readSyncMeta(cfg?.repoPath);
  if (meta?.lastSyncCommit) {
    lines.push(`  Last Sync:       ${meta.lastSyncCommit.slice(0, 12)}`);
    lines.push(`  Last Sync Time:  ${new Date(meta.lastSyncTimestamp).toISOString()}`);
  }
  lines.push("");
  if (s.ahead > 0) lines.push("  ⬆  Pending push to remote");
  if (s.behind > 0) lines.push("  ⬇  Pending pull from remote");
  if (s.hasUncommitted) lines.push(`  ⚠  ${s.uncommittedFiles} uncommitted file(s)`);
  if (s.ahead === 0 && s.behind === 0 && !s.hasUncommitted) lines.push("  ✓  In sync");
  return lines.join("\n");
}

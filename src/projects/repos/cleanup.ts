/**
 * Branch cleanup — dry-run preview, manifest-first execution and restore.
 *
 *   previewCleanup()   builds a plan from a FRESH scan: safe worktrees, safe
 *                      local branches and (only if explicitly selected) safe
 *                      remote branches. Nothing is touched.
 *   executeCleanup()   re-scans, re-applies every safety rule to every item
 *                      (sha unchanged, still clean, still idle, still merged),
 *                      writes the restore manifest + backup refs, THEN deletes.
 *   restoreCleanup()   recreates branches (from the manifest SHAs / backup
 *                      refs) and worktrees (git worktree add) from a manifest.
 *
 * Deletions use `git worktree remove` WITHOUT --force (git itself refuses a
 * dirty worktree) and `git update-ref -d <ref> <old-sha>` (refuses if the
 * branch moved). Every deleted tip is also kept reachable under
 * refs/infinibot-cleanup/<stamp>/… so a restore works even after `git gc`.
 * Stashes are never touched.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  scanRepoHealth,
  type BranchRow,
  type HealthReport,
  type WorktreeRow,
} from "./branch-health.js";
import { cleanupBlockReason, type CleanupCandidate } from "./classify.js";
import { runGit } from "./git-info.js";

export interface CleanupItem extends CleanupCandidate {
  sha: string;
  /** Branch held by a worktree item. */
  branch?: string;
  sizeBytes?: number;
  reasons: string[];
  /** Worktree removal that a branch deletion depends on. */
  viaWorktree?: string;
}

export interface CleanupPlan {
  planId: string;
  repoRoot: string;
  repoName: string;
  deployBranch?: string;
  deployWorktreePath?: string;
  createdAt: number;
  items: CleanupItem[];
  skipped: Array<{ type: CleanupItem["type"]; name: string; reason: string }>;
  reclaimBytes: number;
  includeRemote: string[];
}

export interface ManifestEntry extends CleanupItem {
  status: "pending" | "deleted" | "skipped" | "failed";
  error?: string;
  backupRef?: string;
}

export interface CleanupManifest {
  version: 1;
  id: string;
  repoRoot: string;
  repoName: string;
  deployBranch?: string;
  createdAt: number;
  finishedAt?: number;
  planId: string;
  entries: ManifestEntry[];
  restoredAt?: number;
  restoreLog?: Array<{ name: string; type: string; ok: boolean; note?: string }>;
  note: string;
}

export interface CleanupOptions {
  deployBranch?: string;
  deployWorktreePath?: string;
  /** Remote branch names ("origin/feat/x") the owner explicitly ticked. */
  includeRemote?: string[];
  /** Restrict to these item names (branch names / worktree paths). */
  only?: string[];
  /** Pre-computed fresh report (tests / the RPC that just scanned). */
  report?: HealthReport;
}

const plans = new Map<string, CleanupPlan>();
const PLAN_TTL_MS = 30 * 60_000;

export function manifestDir(stateDir: string, repoName: string): string {
  const slug = repoName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return path.join(stateDir, "repo-cleanup", slug);
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

function buildPlan(report: HealthReport, opts: CleanupOptions): CleanupPlan {
  const deployBranch = opts.deployBranch ?? report.deployBranch;
  const deployWorktreePath = opts.deployWorktreePath
    ? path.resolve(opts.deployWorktreePath)
    : undefined;
  const includeRemote = opts.includeRemote ?? [];
  const only = opts.only ? new Set(opts.only) : null;
  const items: CleanupItem[] = [];
  const skipped: CleanupPlan["skipped"] = [];
  const wtByPath = new Map(report.worktrees.map((w) => [w.path, w]));
  const ctx = { deployBranch, deployWorktreePath };

  const removedWorktrees = new Set<string>();
  for (const w of report.worktrees) {
    if (w.group !== "safe" || w.main) continue;
    if (only && !only.has(w.path)) continue;
    const reason = cleanupBlockReason(
      { type: "worktree", name: w.path, path: w.path },
      { worktree: w, worktreeClass: w },
      ctx,
    );
    if (reason) {
      skipped.push({ type: "worktree", name: w.path, reason });
      continue;
    }
    removedWorktrees.add(w.path);
    items.push({
      type: "worktree",
      name: w.path,
      path: w.path,
      sha: w.head,
      branch: w.branch,
      sizeBytes: w.sizeBytes,
      reasons: w.reasons,
    });
  }

  for (const b of report.branches) {
    if (b.kind !== "local" || b.group !== "safe") continue;
    if (only && !only.has(b.shortName) && !b.worktreePaths.some((p) => only.has(p))) continue;
    const others = b.worktreePaths.filter((p) => !removedWorktrees.has(p));
    const reason = cleanupBlockReason(
      { type: "branch", name: b.shortName },
      { branch: b, branchClass: b, otherCheckouts: others },
      ctx,
    );
    if (reason) {
      skipped.push({ type: "branch", name: b.shortName, reason });
      continue;
    }
    items.push({
      type: "branch",
      name: b.shortName,
      sha: b.sha,
      reasons: b.reasons,
      viaWorktree: b.worktreePaths.find((p) => removedWorktrees.has(p)),
    });
  }

  for (const name of includeRemote) {
    const b = report.branches.find((x) => x.kind === "remote" && x.name === name);
    const reason = b
      ? b.group !== "safe"
        ? (b.reasons[0] ?? "not classified safe")
        : cleanupBlockReason(
            { type: "remote-branch", name },
            { branch: b, branchClass: b },
            { ...ctx, allowRemote: true },
          )
      : "remote branch not found";
    if (reason || !b) {
      skipped.push({ type: "remote-branch", name, reason: reason ?? "not found" });
      continue;
    }
    items.push({ type: "remote-branch", name, sha: b.sha, reasons: b.reasons });
  }

  // Everything else that is NOT safe, for the preview's "kept" list.
  for (const b of report.branches) {
    if (b.kind === "local" && b.group !== "safe" && (!only || only.has(b.shortName))) {
      skipped.push({
        type: "branch",
        name: b.shortName,
        reason: `${b.group}: ${b.reasons[0] ?? ""}`,
      });
    }
  }
  for (const w of report.worktrees) {
    if (w.group !== "safe" && !w.main && (!only || only.has(w.path))) {
      skipped.push({ type: "worktree", name: w.path, reason: `${w.group}: ${w.reasons[0] ?? ""}` });
    }
  }

  const reclaimBytes = items.reduce(
    (n, i) => n + (i.type === "worktree" ? (wtByPath.get(i.name)?.sizeBytes ?? 0) : 0),
    0,
  );
  const fingerprint = items
    .map((i) => `${i.type}:${i.name}:${i.sha}`)
    .sort()
    .join("\n");
  const planId = crypto
    .createHash("sha256")
    .update(`${report.root}\n${deployBranch ?? ""}\n${fingerprint}`)
    .digest("hex")
    .slice(0, 16);
  return {
    planId,
    repoRoot: report.root,
    repoName: report.name,
    deployBranch,
    deployWorktreePath,
    createdAt: Date.now(),
    items,
    skipped,
    reclaimBytes,
    includeRemote,
  };
}

/** Dry run: what a cleanup would remove right now. Touches nothing. */
export async function previewCleanup(
  root: string,
  opts: CleanupOptions = {},
): Promise<CleanupPlan> {
  const report =
    opts.report ??
    (await scanRepoHealth(root, {
      deployBranch: opts.deployBranch,
      deployWorktreePath: opts.deployWorktreePath,
      sizes: true,
      github: true,
    }));
  const plan = buildPlan(report, opts);
  plans.set(plan.planId, plan);
  for (const [id, p] of plans) if (Date.now() - p.createdAt > PLAN_TTL_MS) plans.delete(id);
  return plan;
}

export function getCleanupPlan(planId: string): CleanupPlan | undefined {
  return plans.get(planId);
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * Run a previewed plan. Each item is re-validated against a fresh scan;
 * anything that changed since the preview is skipped, never forced.
 */
export async function executeCleanup(
  stateDir: string,
  planId: string,
  opts: { confirm: boolean; report?: HealthReport } = { confirm: false },
): Promise<{ manifest: CleanupManifest; manifestPath: string }> {
  if (!opts.confirm) throw new Error("cleanup needs confirm: true (preview first)");
  const plan = plans.get(planId);
  if (!plan) throw new Error("cleanup plan expired — run the preview again");
  const fresh =
    opts.report ??
    (await scanRepoHealth(plan.repoRoot, {
      deployBranch: plan.deployBranch,
      deployWorktreePath: plan.deployWorktreePath,
      sizes: false,
      github: false,
    }));
  const branchByName = new Map<string, BranchRow>(fresh.branches.map((b) => [b.name, b]));
  const wtByPath = new Map<string, WorktreeRow>(fresh.worktrees.map((w) => [w.path, w]));
  const ctx = { deployBranch: plan.deployBranch, deployWorktreePath: plan.deployWorktreePath };
  const at = Date.now();
  const id = stamp(at);
  const removing = new Set(plan.items.filter((i) => i.type === "worktree").map((i) => i.name));

  const entries: ManifestEntry[] = plan.items.map((item) => {
    let reason: string | null = null;
    if (item.type === "worktree") {
      const w = wtByPath.get(item.name);
      reason = w
        ? w.head !== item.sha
          ? "worktree moved since the preview"
          : cleanupBlockReason(item, { worktree: w, worktreeClass: w }, ctx)
        : "worktree no longer exists";
    } else {
      const key = item.type === "branch" ? item.name : item.name;
      const b = branchByName.get(key);
      reason = b
        ? b.sha !== item.sha
          ? "branch moved since the preview"
          : cleanupBlockReason(
              item,
              {
                branch: b,
                branchClass: b,
                otherCheckouts: b.worktreePaths.filter((p) => !removing.has(p)),
              },
              {
                ...ctx,
                allowRemote:
                  item.type === "remote-branch" && plan.includeRemote.includes(item.name),
              },
            )
        : "branch no longer exists";
    }
    return reason
      ? { ...item, status: "skipped" as const, error: reason }
      : { ...item, status: "pending" as const };
  });

  const manifest: CleanupManifest = {
    version: 1,
    id,
    repoRoot: plan.repoRoot,
    repoName: plan.repoName,
    deployBranch: plan.deployBranch,
    createdAt: at,
    planId,
    entries,
    note:
      "Restore recreates branches at these SHAs and re-adds worktrees with `git worktree add`. " +
      "Ignored files that lived only in a removed worktree (node_modules, build output) are not restored.",
  };
  const file = path.join(manifestDir(stateDir, plan.repoName), `${id}.json`);
  // Manifest + backup refs FIRST — nothing is deleted before both exist.
  for (const e of entries) {
    if (e.status !== "pending") continue;
    const refName =
      e.type === "worktree"
        ? `refs/infinibot-cleanup/${id}/worktree/${path.basename(e.name)}`
        : `refs/infinibot-cleanup/${id}/${e.type === "remote-branch" ? "remote/" : ""}${e.name}`;
    const r = await runGit(plan.repoRoot, ["update-ref", refName, e.sha]);
    if (r.ok) e.backupRef = refName;
  }
  writeJsonAtomic(file, manifest);

  // 1. Worktrees (git refuses dirty ones without --force — we never pass it).
  for (const e of entries) {
    if (e.status !== "pending" || e.type !== "worktree") continue;
    const w = wtByPath.get(e.name);
    const r =
      w?.missing || w?.prunable
        ? await runGit(plan.repoRoot, ["worktree", "prune"])
        : await runGit(plan.repoRoot, ["worktree", "remove", e.name], { timeoutMs: 120_000 });
    if (r.ok) e.status = "deleted";
    else {
      e.status = "failed";
      e.error = r.stderr.trim().slice(0, 300) || "git worktree remove failed";
    }
  }
  // 2. Local branches — only if the worktree holding them (if any) is gone.
  for (const e of entries) {
    if (e.status !== "pending" || e.type !== "branch") continue;
    const via = e.viaWorktree
      ? entries.find((x) => x.type === "worktree" && x.name === e.viaWorktree)
      : null;
    if (via && via.status !== "deleted") {
      e.status = "skipped";
      e.error = "its worktree was not removed";
      continue;
    }
    const r = await runGit(plan.repoRoot, ["update-ref", "-d", `refs/heads/${e.name}`, e.sha]);
    if (r.ok) e.status = "deleted";
    else {
      e.status = "failed";
      e.error = r.stderr.trim().slice(0, 300) || "git update-ref -d failed";
    }
  }
  // 3. Remote branches (explicitly selected only).
  for (const e of entries) {
    if (e.status !== "pending" || e.type !== "remote-branch") continue;
    const [remote, ...rest] = e.name.split("/");
    const r = await runGit(
      plan.repoRoot,
      [
        "push",
        remote,
        `--force-with-lease=refs/heads/${rest.join("/")}:${e.sha}`,
        "--delete",
        rest.join("/"),
      ],
      { timeoutMs: 60_000 },
    );
    if (r.ok) e.status = "deleted";
    else {
      e.status = "failed";
      e.error = r.stderr.trim().slice(0, 300) || "git push --delete failed";
    }
  }
  manifest.finishedAt = Date.now();
  writeJsonAtomic(file, manifest);
  plans.delete(planId);
  return { manifest, manifestPath: file };
}

export function listManifests(
  stateDir: string,
  repoName: string,
): Array<{ id: string; path: string; createdAt: number; deleted: number; restoredAt?: number }> {
  const dir = manifestDir(stateDir, repoName);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as CleanupManifest;
        return {
          id: m.id,
          path: path.join(dir, f),
          createdAt: m.createdAt,
          deleted: m.entries.filter((e) => e.status === "deleted").length,
          restoredAt: m.restoredAt,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function readManifest(
  stateDir: string,
  repoName: string,
  id: string,
): { manifest: CleanupManifest; path: string } {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad manifest id");
  const file = path.join(manifestDir(stateDir, repoName), `${id}.json`);
  return { manifest: JSON.parse(fs.readFileSync(file, "utf8")) as CleanupManifest, path: file };
}

/** Recreate what a manifest deleted. Existing branches/folders are left alone. */
export async function restoreCleanup(
  stateDir: string,
  repoName: string,
  id: string,
  opts: { includeRemote?: boolean } = {},
): Promise<CleanupManifest> {
  const { manifest, path: file } = readManifest(stateDir, repoName, id);
  const root = manifest.repoRoot;
  const log: NonNullable<CleanupManifest["restoreLog"]> = [];
  const deleted = manifest.entries.filter((e) => e.status === "deleted");
  // Branches first (worktrees check them out).
  for (const e of deleted.filter((x) => x.type === "branch")) {
    const cur = await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${e.name}`]);
    if (cur.ok) {
      log.push({
        name: e.name,
        type: e.type,
        ok: cur.stdout.trim() === e.sha,
        note:
          cur.stdout.trim() === e.sha
            ? "already there"
            : "a branch with this name exists at another commit — left alone",
      });
      continue;
    }
    const r = await runGit(root, ["update-ref", `refs/heads/${e.name}`, e.sha, ""]);
    log.push({
      name: e.name,
      type: e.type,
      ok: r.ok,
      note: r.ok ? `recreated at ${e.sha.slice(0, 8)}` : r.stderr.trim().slice(0, 200),
    });
  }
  for (const e of deleted.filter((x) => x.type === "worktree")) {
    if (fs.existsSync(e.name)) {
      log.push({
        name: e.name,
        type: e.type,
        ok: false,
        note: "folder already exists — left alone",
      });
      continue;
    }
    const args = e.branch
      ? ["worktree", "add", e.name, e.branch]
      : ["worktree", "add", "--detach", e.name, e.sha];
    const r = await runGit(root, args, { timeoutMs: 180_000 });
    log.push({
      name: e.name,
      type: e.type,
      ok: r.ok,
      note: r.ok
        ? "worktree re-added (reinstall dependencies before use)"
        : r.stderr.trim().slice(0, 200),
    });
  }
  for (const e of deleted.filter((x) => x.type === "remote-branch")) {
    if (!opts.includeRemote) {
      log.push({ name: e.name, type: e.type, ok: false, note: "remote restore not requested" });
      continue;
    }
    const [remote, ...rest] = e.name.split("/");
    const r = await runGit(root, ["push", remote, `${e.sha}:refs/heads/${rest.join("/")}`], {
      timeoutMs: 60_000,
    });
    log.push({
      name: e.name,
      type: e.type,
      ok: r.ok,
      note: r.ok ? "pushed back" : r.stderr.trim().slice(0, 200),
    });
  }
  manifest.restoredAt = Date.now();
  manifest.restoreLog = log;
  writeJsonAtomic(file, manifest);
  return manifest;
}

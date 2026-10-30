/**
 * Per-file inspection RPCs powering the agent-focus modal's file-diff drawer.
 *
 * The subagent-detail modal lists the files an agent touched. These handlers
 * let the user inspect and act on each file WITHOUT leaving InfiniBot:
 *
 *   files.diff   — before/after content + unified patch + numstat + status,
 *                  scoped to the run's workdir (the repo the agent ran in).
 *   files.revert — discard the change for one file (checkout HEAD / delete created).
 *   files.accept — stage + commit just that one file (pathspec commit).
 *   files.openInEditor — best-effort launch of the OS editor (code/$EDITOR).
 *
 * Diffs are computed against HEAD (working-tree + index), which is the correct
 * window for an agent run whose changes are left uncommitted on the branch.
 *
 * Multi-user safety: the repo path is taken from the run record's `workdir`
 * (the authoritative location the agent actually wrote to). The run is resolved
 * by runId through the subagent registry, so a caller can only reach files in a
 * run that exists for this gateway instance.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getSubagentRun } from "../../agents/subagent-registry.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── git helper (isolated env, arg-array safe) ────────────────────────────────

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[k];
  env.HUSKY = "0";
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();
}

function safeGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Resolve the repo workdir for a run, validating it is a git repo. */
function resolveRunRepo(runId: string): { cwd: string } {
  const run = runId ? getSubagentRun(runId) : undefined;
  const cwd = run?.workdir && run.workdir.trim() ? run.workdir : process.cwd();
  // Verify it's a git repo (throws otherwise).
  execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd,
    timeout: 15000,
    windowsHide: true,
    env: gitEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { cwd };
}

/** Normalize an incoming path to a repo-relative path. */
function toRepoRelative(cwd: string, p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (path.isAbsolute(norm)) {
    const rel = path.relative(cwd, norm);
    // If the file is outside the repo, fall back to the basename-less original;
    // git will reject it cleanly and the caller sees an error.
    return rel.startsWith("..") ? norm : rel;
  }
  return norm;
}

type FileStatus = "created" | "modified" | "deleted" | "renamed" | "unchanged";

/** Map a porcelain XY code to a friendly status. Untracked (`??`) = created. */
function statusFromPorcelain(cwd: string, rel: string): FileStatus {
  const out = safeGit(cwd, ["status", "--porcelain=v1", "--", rel]);
  if (!out) {
    // Not in status — either unchanged-tracked or doesn't exist.
    return fs.existsSync(path.join(cwd, rel)) ? "unchanged" : "deleted";
  }
  const line = out.split("\n").find(Boolean) ?? "";
  const code = line.slice(0, 2);
  if (code === "??") return "created";
  if (code.includes("A")) return "created";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("M") || code.includes("T")) return "modified";
  return "modified";
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const MAX_BLOB = 400_000; // 400KB per side cap — diffs above this stay summary-only.

export const filesDiffHandlers: GatewayRequestHandlers = {
  /**
   * files.diff({ path, runId })
   *
   * Returns before/after content, a unified patch, numstat (±lines) and a
   * created/modified/deleted/renamed status for one file, scoped to the run's
   * repo. Created/untracked files come back as all-additions; deleted files as
   * all-removals with the previous content in `before`.
   */
  "files.diff": ({ params, respond }) => {
    try {
      const rawPath = typeof params?.path === "string" ? params.path : "";
      const runId = typeof params?.runId === "string" ? params.runId : "";
      if (!rawPath) {
        respond(true, { ok: false, error: "path is required" });
        return;
      }
      const { cwd } = resolveRunRepo(runId);
      const rel = toRepoRelative(cwd, rawPath);
      const status = statusFromPorcelain(cwd, rel);

      // before = HEAD blob (null when the file is new to the repo).
      const before = safeGit(cwd, ["show", `HEAD:${rel}`]);
      // after = working-tree content (null when deleted).
      const abs = path.join(cwd, rel);
      let after: string | null = null;
      let binary = false;
      if (fs.existsSync(abs)) {
        try {
          const buf = fs.readFileSync(abs);
          binary = buf.includes(0);
          after = binary ? null : buf.toString("utf-8");
        } catch {
          after = null;
        }
      }

      // Unified patch. For untracked files `git diff HEAD` shows nothing, so
      // fall back to --no-index against an empty tree.
      let patch = safeGit(cwd, ["diff", "--no-color", "HEAD", "--", rel]) ?? "";
      if (!patch.trim() && status === "created") {
        patch = safeGit(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", rel]) ?? "";
      }

      // numstat: "added\tremoved\tpath" (— — for binary).
      let added = 0;
      let removed = 0;
      const numstat =
        safeGit(cwd, ["diff", "--numstat", "HEAD", "--", rel]) ??
        (status === "created"
          ? safeGit(cwd, ["diff", "--numstat", "--no-index", "--", "/dev/null", rel])
          : null);
      if (numstat) {
        const f = numstat.split("\n").find(Boolean) ?? "";
        const m = f.split("\t");
        if (m[0] === "-" || m[1] === "-") binary = true;
        else {
          added = parseInt(m[0], 10) || 0;
          removed = parseInt(m[1], 10) || 0;
        }
      }
      if (status === "created" && !binary && added === 0 && after) {
        added = after ? after.split("\n").length : 0;
      }
      if (status === "deleted" && !binary && removed === 0 && before) {
        removed = before.split("\n").length;
      }

      const tooBig = (before?.length ?? 0) > MAX_BLOB || (after?.length ?? 0) > MAX_BLOB;

      respond(true, {
        ok: true,
        path: rel,
        absPath: abs,
        status,
        binary,
        added,
        removed,
        before: tooBig ? null : before,
        after: tooBig ? null : after,
        patch: patch.length > 200_000 ? patch.slice(0, 200_000) + "\n… (truncated)" : patch,
        truncated: tooBig,
      });
    } catch (e: any) {
      respond(true, { ok: false, error: e?.message || "files.diff failed" });
    }
  },

  /**
   * files.revert({ path, runId, mode? })
   *
   * Discards one file's change. `mode:"delete"` (or an inferred created status)
   * removes the working-tree file; otherwise restores it from HEAD.
   */
  "files.revert": ({ params, respond }) => {
    try {
      const rawPath = typeof params?.path === "string" ? params.path : "";
      const runId = typeof params?.runId === "string" ? params.runId : "";
      const mode = typeof params?.mode === "string" ? params.mode : "auto";
      if (!rawPath) {
        respond(true, { ok: false, error: "path is required" });
        return;
      }
      const { cwd } = resolveRunRepo(runId);
      const rel = toRepoRelative(cwd, rawPath);
      const status = statusFromPorcelain(cwd, rel);

      const doDelete = mode === "delete" || (mode === "auto" && status === "created");
      if (doDelete) {
        const abs = path.join(cwd, rel);
        // Drop from the index too in case it was staged with `add -N`/`add`.
        safeGit(cwd, ["rm", "-f", "--quiet", "--", rel]);
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
        respond(true, { ok: true, path: rel, action: "deleted" });
        return;
      }

      // Restore tracked file to its HEAD state (unstages + discards edits).
      safeGit(cwd, ["restore", "--staged", "--worktree", "--source=HEAD", "--", rel]) ??
        git(cwd, ["checkout", "HEAD", "--", rel]);
      respond(true, { ok: true, path: rel, action: "reverted" });
    } catch (e: any) {
      respond(true, { ok: false, error: e?.message || "files.revert failed" });
    }
  },

  /**
   * files.accept({ path, runId, message? })
   *
   * Stages and commits ONLY this file (pathspec commit). Leaves every other
   * change in the working tree untouched.
   */
  "files.accept": ({ params, respond }) => {
    try {
      const rawPath = typeof params?.path === "string" ? params.path : "";
      const runId = typeof params?.runId === "string" ? params.runId : "";
      const message =
        typeof params?.message === "string" && params.message.trim()
          ? params.message
          : `Accept agent change: ${rawPath}`;
      if (!rawPath) {
        respond(true, { ok: false, error: "path is required" });
        return;
      }
      const { cwd } = resolveRunRepo(runId);
      const rel = toRepoRelative(cwd, rawPath);

      git(cwd, ["add", "--", rel]);
      // Commit only this pathspec so unrelated staged changes aren't swept in.
      git(cwd, ["commit", "-m", message, "--", rel]);
      const hash = safeGit(cwd, ["rev-parse", "--short", "HEAD"])?.trim() ?? null;
      respond(true, { ok: true, path: rel, committed: true, hash });
    } catch (e: any) {
      respond(true, { ok: false, error: e?.message || "files.accept failed" });
    }
  },

  /**
   * files.openInEditor({ path, runId })
   *
   * Best-effort: spawns `code -g <abs>` (or $VISUAL/$EDITOR, then xdg-open)
   * detached so the gateway never blocks. Returns which launcher was used.
   */
  "files.openInEditor": ({ params, respond }) => {
    try {
      const rawPath = typeof params?.path === "string" ? params.path : "";
      const runId = typeof params?.runId === "string" ? params.runId : "";
      if (!rawPath) {
        respond(true, { ok: false, error: "path is required" });
        return;
      }
      const { cwd } = resolveRunRepo(runId);
      const rel = toRepoRelative(cwd, rawPath);
      const abs = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rel);

      const candidates: Array<{ cmd: string; args: string[] }> = [];
      if (process.env.VISUAL) candidates.push({ cmd: process.env.VISUAL, args: [abs] });
      if (process.env.EDITOR) candidates.push({ cmd: process.env.EDITOR, args: [abs] });
      candidates.push({ cmd: "code", args: ["-g", abs] });
      candidates.push({
        cmd: process.platform === "darwin" ? "open" : "xdg-open",
        args: [abs],
      });

      for (const c of candidates) {
        try {
          const child = spawn(c.cmd, c.args, {
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          respond(true, { ok: true, launcher: c.cmd, path: abs });
          return;
        } catch {
          /* try next */
        }
      }
      respond(true, { ok: false, error: "No editor launcher available" });
    } catch (e: any) {
      respond(true, { ok: false, error: e?.message || "files.openInEditor failed" });
    }
  },
};

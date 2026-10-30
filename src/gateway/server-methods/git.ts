/**
 * Git Gateway RPCs — branch management, status, log, diff, worktree ops.
 * Inspired by Auto-Claude's git_utils + worktree patterns, adapted for InfiniBot gateway.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────

function git(args: string, cwd?: string): string {
  const opts: any = {
    encoding: "utf-8" as const,
    timeout: 30000,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] as any,
  };
  if (cwd) opts.cwd = cwd;
  // Isolate git env (prevent hooks/env contamination like Auto-Claude does)
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
  opts.env = env;

  const out = execSync(`git ${args}`, opts).toString();
  // Porcelain status lines start with a significant space (" M file"); a full
  // trim() ate the first line's column and the first letter of its path.
  return args.startsWith("status --porcelain") ? out.replace(/\s+$/, "") : out.trim();
}

function safeGit(args: string, cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function resolveRepo(params: any): string {
  const cwd = typeof params?.cwd === "string" && params.cwd ? params.cwd : process.cwd();
  // Verify it's a git repo
  try {
    git("rev-parse --git-dir", cwd);
    return cwd;
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }
}

// ── Handlers ─────────────────────────────────────────────────

export const gitHandlers: GatewayRequestHandlers = {
  /** Get repo status: branch, clean/dirty, staged/unstaged counts */
  "git.status": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const branch = safeGit("rev-parse --abbrev-ref HEAD", cwd) ?? "(detached)";
      const statusRaw = git("status --porcelain=v1", cwd);
      const lines = statusRaw ? statusRaw.split("\n").filter(Boolean) : [];

      let staged = 0,
        unstaged = 0,
        untracked = 0;
      for (const l of lines) {
        const x = l[0],
          y = l[1];
        if (x === "?") {
          untracked++;
          continue;
        }
        if (x !== " " && x !== "?") staged++;
        if (y !== " " && y !== "?") unstaged++;
      }

      const ahead = safeGit("rev-list --count @{upstream}..HEAD", cwd);
      const behind = safeGit("rev-list --count HEAD..@{upstream}", cwd);
      const remoteUrl = safeGit("remote get-url origin", cwd);

      respond(true, {
        branch,
        clean: lines.length === 0,
        staged,
        unstaged,
        untracked,
        ahead: ahead ? parseInt(ahead, 10) : 0,
        behind: behind ? parseInt(behind, 10) : 0,
        remote: remoteUrl ?? null,
        files: lines.slice(0, 50).map((l) => ({
          status: l.slice(0, 2),
          path: l.slice(3),
        })),
      });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git status failed" });
    }
  },

  /** List branches (local + remote) */
  "git.branches": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const current = safeGit("rev-parse --abbrev-ref HEAD", cwd) ?? "";
      const localRaw = git("branch --format=%(refname:short)", cwd);
      const local = localRaw ? localRaw.split("\n").filter(Boolean) : [];
      const remoteRaw = safeGit("branch -r --format=%(refname:short)", cwd);
      const remote = remoteRaw ? remoteRaw.split("\n").filter(Boolean) : [];

      respond(true, { current, local, remote });
    } catch (e: any) {
      respond(false, undefined, {
        code: "GIT_ERROR",
        message: e?.message || "git branches failed",
      });
    }
  },

  /** Switch branch */
  "git.checkout": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const branch = typeof params?.branch === "string" ? params.branch : "";
      const create = params?.create === true;
      if (!branch) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "branch is required" });
        return;
      }

      if (create) {
        git(`checkout -b ${branch}`, cwd);
      } else {
        git(`checkout ${branch}`, cwd);
      }

      respond(true, { branch, created: create });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "checkout failed" });
    }
  },

  /** Git log (last N commits) */
  "git.log": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const limit = typeof params?.limit === "number" ? Math.min(params.limit, 100) : 20;
      const format = "--format=%H|%h|%an|%ae|%at|%s";
      const raw = git(`log ${format} -n ${limit}`, cwd);
      const commits = raw
        ? raw
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [hash, short, author, email, ts, ...msgParts] = line.split("|");
              return {
                hash,
                short,
                author,
                email,
                date: new Date(parseInt(ts, 10) * 1000).toISOString(),
                message: msgParts.join("|"),
              };
            })
        : [];

      respond(true, { commits });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git log failed" });
    }
  },

  /** Git diff (working tree or between refs) */
  "git.diff": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const staged = params?.staged === true;
      const ref1 = typeof params?.ref1 === "string" ? params.ref1 : "";
      const ref2 = typeof params?.ref2 === "string" ? params.ref2 : "";
      const filePath = typeof params?.path === "string" ? params.path : "";

      let cmd = "diff --stat";
      if (staged) cmd = "diff --cached --stat";
      if (ref1 && ref2) cmd = `diff ${ref1}..${ref2} --stat`;
      if (filePath) cmd += ` -- ${filePath}`;

      const stat = git(cmd, cwd);

      // Also get the raw diff if requested
      let patch: string | null = null;
      if (params?.patch === true) {
        const patchCmd = cmd.replace("--stat", "");
        patch = git(patchCmd.trim(), cwd);
        // Limit to 50KB
        if (patch && patch.length > 50000) patch = patch.slice(0, 50000) + "\n... (truncated)";
      }

      respond(true, { stat, patch });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git diff failed" });
    }
  },

  /** Stage files */
  "git.add": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const files = Array.isArray(params?.files) ? params.files : ["."];
      git(`add ${files.join(" ")}`, cwd);
      respond(true, { added: files });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git add failed" });
    }
  },

  /** Commit staged changes */
  "git.commit": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const message = typeof params?.message === "string" ? params.message : "";
      if (!message) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "commit message is required",
        });
        return;
      }

      // Escape message for shell
      const escaped = message.replace(/"/g, '\\"');
      const result = git(`commit -m "${escaped}"`, cwd);
      const hash = safeGit("rev-parse --short HEAD", cwd);

      respond(true, { message: result, hash });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git commit failed" });
    }
  },

  /** Push to remote */
  "git.push": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const remote = typeof params?.remote === "string" ? params.remote : "origin";
      const branch = typeof params?.branch === "string" ? params.branch : "";
      const force = params?.force === true;

      let cmd = `push ${remote}`;
      if (branch) cmd += ` ${branch}`;
      if (force) cmd += " --force-with-lease";

      const result = git(cmd, cwd);
      respond(true, { result });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git push failed" });
    }
  },

  /** Pull from remote */
  "git.pull": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const rebase = params?.rebase === true;
      const cmd = rebase ? "pull --rebase" : "pull";
      const result = git(cmd, cwd);
      respond(true, { result });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git pull failed" });
    }
  },

  /** Fetch from remote */
  "git.fetch": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const prune = params?.prune === true;
      const cmd = prune ? "fetch --prune" : "fetch";
      const result = git(cmd, cwd);
      respond(true, { result });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git fetch failed" });
    }
  },

  /** Stash operations */
  "git.stash": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const op = typeof params?.op === "string" ? params.op : "push";
      const message = typeof params?.message === "string" ? params.message : "";

      let cmd: string;
      switch (op) {
        case "push":
          cmd = message ? `stash push -m "${message.replace(/"/g, '\\"')}"` : "stash push";
          break;
        case "pop":
          cmd = "stash pop";
          break;
        case "list":
          cmd = "stash list";
          break;
        case "drop":
          cmd = "stash drop";
          break;
        case "apply":
          cmd = "stash apply";
          break;
        default:
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: `unknown stash op: ${op}`,
          });
          return;
      }

      const result = git(cmd, cwd);
      respond(true, { result });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git stash failed" });
    }
  },

  /** Reset (soft/mixed/hard) */
  "git.reset": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const mode = typeof params?.mode === "string" ? params.mode : "mixed";
      const ref = typeof params?.ref === "string" ? params.ref : "HEAD";
      if (!["soft", "mixed", "hard"].includes(mode)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "mode must be soft/mixed/hard",
        });
        return;
      }
      const result = git(`reset --${mode} ${ref}`, cwd);
      respond(true, { result });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git reset failed" });
    }
  },

  /** Create/delete/list tags */
  "git.tag": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const op = typeof params?.op === "string" ? params.op : "list";
      const name = typeof params?.name === "string" ? params.name : "";
      const message = typeof params?.message === "string" ? params.message : "";

      switch (op) {
        case "list": {
          const raw = git("tag -l --sort=-creatordate", cwd);
          const tags = raw ? raw.split("\n").filter(Boolean) : [];
          respond(true, { tags });
          break;
        }
        case "create": {
          if (!name) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: "tag name required" });
            return;
          }
          if (message) git(`tag -a ${name} -m "${message.replace(/"/g, '\\"')}"`, cwd);
          else git(`tag ${name}`, cwd);
          respond(true, { tag: name, created: true });
          break;
        }
        case "delete": {
          if (!name) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: "tag name required" });
            return;
          }
          git(`tag -d ${name}`, cwd);
          respond(true, { tag: name, deleted: true });
          break;
        }
        default:
          respond(false, undefined, { code: "INVALID_REQUEST", message: `unknown tag op: ${op}` });
      }
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git tag failed" });
    }
  },

  /** Merge a branch */
  "git.merge": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const branch = typeof params?.branch === "string" ? params.branch : "";
      if (!branch) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "branch required" });
        return;
      }
      const noFf = params?.noFf === true;
      const cmd = noFf ? `merge --no-ff ${branch}` : `merge ${branch}`;
      const result = git(cmd, cwd);
      respond(true, { result });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "merge failed" });
    }
  },

  /** Worktree management (list/add/remove) — following Auto-Claude's pattern */
  "git.worktree": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const op = typeof params?.op === "string" ? params.op : "list";

      switch (op) {
        case "list": {
          const raw = git("worktree list --porcelain", cwd);
          const worktrees: Array<{ path: string; head: string; branch: string }> = [];
          let current: any = {};
          for (const line of (raw || "").split("\n")) {
            if (line.startsWith("worktree ")) {
              current = { path: line.slice(9) };
            } else if (line.startsWith("HEAD ")) {
              current.head = line.slice(5);
            } else if (line.startsWith("branch ")) {
              current.branch = line.slice(7).replace("refs/heads/", "");
            } else if (line === "") {
              if (current.path) worktrees.push(current);
              current = {};
            }
          }
          if (current.path) worktrees.push(current);
          respond(true, { worktrees });
          break;
        }
        case "add": {
          const wtPath = typeof params?.path === "string" ? params.path : "";
          const branch = typeof params?.branch === "string" ? params.branch : "";
          if (!wtPath) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: "path required" });
            return;
          }

          let cmd = `worktree add "${wtPath}"`;
          if (branch) cmd += ` -b ${branch}`;
          const result = git(cmd, cwd);
          respond(true, { result, path: wtPath, branch });
          break;
        }
        case "remove": {
          const wtPath = typeof params?.path === "string" ? params.path : "";
          if (!wtPath) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: "path required" });
            return;
          }
          const force = params?.force === true;
          const cmd = force ? `worktree remove --force "${wtPath}"` : `worktree remove "${wtPath}"`;
          const result = git(cmd, cwd);
          respond(true, { result });
          break;
        }
        default:
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: `unknown worktree op: ${op}`,
          });
      }
    } catch (e: any) {
      respond(false, undefined, {
        code: "GIT_ERROR",
        message: e?.message || "git worktree failed",
      });
    }
  },

  /** Blame a file (first 50 lines or around a specific line) */
  "git.blame": async ({ params, respond }) => {
    try {
      const cwd = resolveRepo(params);
      const filePath = typeof params?.path === "string" ? params.path : "";
      if (!filePath) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "path required" });
        return;
      }

      const lineStart = typeof params?.lineStart === "number" ? params.lineStart : 1;
      const lineEnd = typeof params?.lineEnd === "number" ? params.lineEnd : lineStart + 50;

      const raw = git(`blame -L ${lineStart},${lineEnd} --porcelain "${filePath}"`, cwd);
      respond(true, { blame: raw });
    } catch (e: any) {
      respond(false, undefined, { code: "GIT_ERROR", message: e?.message || "git blame failed" });
    }
  },
};

/**
 * Autonomous task approval + GitHub precheck gateway handlers.
 *
 *   autonomy.precheck         — validates the working dir is a git repo
 *                               with a GitHub remote before any autonomous
 *                               run is allowed.
 *   autonomy.approval.request — creates a pending approval (the unified
 *                               registry delivers it to Telegram).
 *   autonomy.approval.status  — UI polling endpoint.
 *   autonomy.approval.resolve — manual override (dashboard / dev tooling).
 *   autonomy.approval.list    — list pending approvals.
 */

import { execSync } from "node:child_process";
import {
  createApproval,
  getApproval,
  listPendingApprovals,
  resolveApproval,
} from "../../autonomy/approval-registry.js";
import { classifyTask } from "../../autonomy/criticality.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Git helpers (kept tiny; mirrors logic in server-methods/git.ts) ─

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

function safeGit(args: string, cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function isGithubRemote(url: string | null): boolean {
  if (!url) return false;
  return /github\.com[:/]/i.test(url);
}

function parseGithubSlug(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Telegram delivery for these approvals is handled centrally by the unified
// approval registry's Telegram notifier (src/approvals/telegram-approvals.ts).

// ── Handlers ──────────────────────────────────────────────────────

export const autopilotApprovalHandlers: GatewayRequestHandlers = {
  /**
   * Validates that the working dir is a git repo with a GitHub remote so
   * autonomous mode has somewhere to push commits + open PRs.
   */
  "autonomy.precheck": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { cwd?: unknown };
      const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.cwd();

      // Is this even a git repo?
      const gitDir = safeGit("rev-parse --git-dir", cwd);
      if (!gitDir) {
        respond(true, {
          ok: false,
          reason: "not_a_git_repo",
          cwd,
          message: `${cwd} is not a git repository.`,
        });
        return;
      }

      const branch = safeGit("rev-parse --abbrev-ref HEAD", cwd) ?? "(detached)";
      const remoteUrl = safeGit("remote get-url origin", cwd);
      const isGithub = isGithubRemote(remoteUrl);
      const slug = parseGithubSlug(remoteUrl);

      const statusRaw = safeGit("status --porcelain=v1", cwd) ?? "";
      const dirtyFiles = statusRaw ? statusRaw.split("\n").filter(Boolean).length : 0;

      const ahead = safeGit("rev-list --count @{upstream}..HEAD", cwd);
      const behind = safeGit("rev-list --count HEAD..@{upstream}", cwd);

      const defaultBranch =
        safeGit("symbolic-ref refs/remotes/origin/HEAD", cwd)?.split("/").pop() ?? "main";

      const ok = !!isGithub;
      respond(true, {
        ok,
        cwd,
        branch,
        remote: remoteUrl,
        isGithub,
        github: slug,
        defaultBranch,
        onDefaultBranch: branch === defaultBranch,
        dirtyFiles,
        ahead: ahead ? parseInt(ahead, 10) : 0,
        behind: behind ? parseInt(behind, 10) : 0,
        reason: ok ? null : "no_github_remote",
        message: ok
          ? null
          : remoteUrl
            ? `Origin "${remoteUrl}" is not a GitHub remote.`
            : `No "origin" remote is configured. Add a GitHub remote before starting an autonomous run.`,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Classify a task using the heuristic + repo metadata. Used by the UI to
   * decide whether to show the approval gate.
   */
  "autonomy.classify": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        prompt?: unknown;
        agentId?: unknown;
        autonomous?: unknown;
        dirtyFiles?: unknown;
        onDefaultBranch?: unknown;
      };
      const result = classifyTask({
        prompt: typeof p.prompt === "string" ? p.prompt : "",
        agentId: typeof p.agentId === "string" ? p.agentId : undefined,
        autonomous: p.autonomous === true,
        dirtyFiles: typeof p.dirtyFiles === "number" ? p.dirtyFiles : undefined,
        onDefaultBranch: p.onDefaultBranch === true,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Open a Telegram approval prompt and return immediately with the request
   * id. The UI polls `autonomy.approval.status` for the decision.
   */
  "autonomy.approval.request": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        title?: unknown;
        summary?: unknown;
        context?: unknown;
        criticality?: unknown;
        taskId?: unknown;
        timeoutMs?: unknown;
      };
      const title = typeof p.title === "string" ? p.title : "Autonomous task";
      const summary = typeof p.summary === "string" ? p.summary : "";
      const context = typeof p.context === "string" ? p.context : "";
      const criticality =
        p.criticality === "low" || p.criticality === "critical" ? p.criticality : "medium";
      const taskId = typeof p.taskId === "string" ? p.taskId : null;
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : undefined;

      const { record } = createApproval({
        title,
        summary,
        context,
        criticality,
        taskId,
        timeoutMs,
      });
      respond(true, { id: record.id, status: record.status, expiresAt: record.expiresAt });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy.approval.status": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { id?: unknown };
      if (typeof p.id !== "string") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const rec = getApproval(p.id);
      if (!rec) {
        respond(true, { id: p.id, status: "unknown" });
        return;
      }
      respond(true, rec);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy.approval.resolve": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { id?: unknown; decision?: unknown; by?: unknown };
      if (typeof p.id !== "string") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      if (p.decision !== "approved" && p.decision !== "denied") {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "decision must be approved or denied",
        });
        return;
      }
      const ok = resolveApproval(p.id, p.decision, typeof p.by === "string" ? p.by : null, "ui");
      respond(true, { id: p.id, resolved: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy.approval.list": async ({ respond }) => {
    try {
      respond(true, { pending: listPendingApprovals() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

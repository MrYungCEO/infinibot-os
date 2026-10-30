/**
 * `project_repos` agent tool — where a repo deploys from, and its branch
 * health. Read-only for agents: cleanup (deleting branches/worktrees) is an
 * owner action on the Repos page, so this tool can preview but never delete.
 */

import { Type } from "@sinclair/typebox";
import { previewCleanup } from "../../projects/repos/cleanup.js";
import { readRegistry } from "../../projects/repos/registry.js";
import {
  deployTargetFor,
  readHealthReport,
  resolveRepoFromRegistry,
  startHealthScan,
  stateDir,
} from "../../projects/repos/service.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const ACTIONS = ["deployTarget", "list", "health", "scan", "cleanupPreview"] as const;

const Schema = Type.Object({
  action: stringEnum(ACTIONS),
  /** Any folder inside the repo (a worktree path works too). */
  path: Type.Optional(Type.String()),
  /** Board project id with an attached repo. */
  projectId: Type.Optional(Type.String()),
  /** Registry key (from action "list"). */
  repoKey: Type.Optional(Type.String()),
});

export function createProjectReposTool(): AnyAgentTool {
  return {
    name: "project_repos",
    label: "Project repos",
    description:
      "Where each attached git repo deploys from, and its branch health. " +
      'Actions: "deployTarget" (path | projectId | repoKey) → deploy branch, deploy folder (absolute path), target (Fly app / InfiniBot gateway / Netlify), ' +
      "deploy command, ahead/behind origin, uncommitted changes and plain instructions — CALL THIS BEFORE ANY DEPLOY; " +
      '"list" → registered repos with deploy branch + last health totals; "health" → last branch-health report summary ' +
      '(safe to delete / review / active / protected, stashes, unique work); "scan" → run a fresh scan (takes seconds); ' +
      '"cleanupPreview" → dry-run list of what the owner\'s "Clean up safe branches" would remove. ' +
      "Agents never delete branches, worktrees or stashes — the owner confirms cleanup on the Repos page.",
    parameters: Schema,
    execute: async (_id, args) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, "action", { required: true });
      const ref = {
        path: readStringParam(p, "path"),
        projectId: readStringParam(p, "projectId"),
        repoKey: readStringParam(p, "repoKey"),
      };
      const reg = readRegistry(stateDir());
      if (action === "list") {
        return jsonResult({
          repos: Object.values(reg.repos).map((r) => ({
            repoKey: r.key,
            name: r.name,
            root: r.root,
            deploy: r.deploy ?? null,
            lastHealth: r.lastHealth ?? null,
          })),
        });
      }
      if (!ref.path && !ref.projectId && !ref.repoKey) ref.path = process.cwd();
      if (action === "deployTarget") {
        const info = await deployTargetFor(ref);
        return jsonResult(
          info ?? { error: "not a registered git repo — pass path, projectId or repoKey" },
        );
      }
      const r = resolveRepoFromRegistry(reg, ref);
      if (!r?.record) {
        return jsonResult({
          error: "repo is not registered yet — the owner can add it on the Repos page",
        });
      }
      const rec = r.record;
      const brief = (report: NonNullable<ReturnType<typeof readHealthReport>>) => ({
        repo: rec.name,
        scannedAt: new Date(report.scannedAt).toISOString(),
        comparedAgainst: report.deployBranch ?? report.defaultBranch,
        totals: report.totals,
        warnings: report.warnings,
        review: report.branches
          .filter((b) => b.kind === "local" && b.group === "review")
          .slice(0, 40)
          .map((b) => ({
            branch: b.shortName,
            why: b.reasons.join("; "),
            worktrees: b.worktreePaths,
          })),
        safe: report.branches
          .filter((b) => b.kind === "local" && b.group === "safe")
          .slice(0, 60)
          .map((b) => b.shortName),
        stashes: report.stashes.map((s) => ({
          ref: s.ref,
          branch: s.branch,
          message: s.message,
          files: s.files,
        })),
      });
      if (action === "health") {
        const report = readHealthReport(rec);
        return jsonResult(report ? brief(report) : { error: 'no scan yet — use action "scan"' });
      }
      if (action === "scan") {
        return jsonResult(brief(await startHealthScan(rec, { sizes: false, github: true })));
      }
      if (action === "cleanupPreview") {
        const plan = await previewCleanup(rec.root, {
          deployBranch: rec.deploy?.branch,
          deployWorktreePath: rec.deploy?.worktreePath,
        });
        return jsonResult({
          note: "Dry run only. The owner runs the cleanup from the Repos page.",
          wouldRemove: plan.items.map((i) => ({ type: i.type, name: i.name, sha: i.sha })),
          reclaimBytes: plan.reclaimBytes,
          kept: plan.skipped.length,
        });
      }
      return jsonResult({ error: `unknown action ${action}` });
    },
  };
}

/**
 * Project repos RPCs — attach a local git checkout to a kanban project and
 * expose it to the UI (badges, directory pickers, KG "Repos" mode).
 *
 *   projects.repo.status      (read)  { projectIds?, fresh? } → { repos: { [projectId]: ProjectRepo } }
 *   projects.repo.inspect     (read)  { path, fresh? } → RepoInfo
 *   projects.repo.browse      (read)  { path?, showHidden? } → BrowseResult
 *   projects.repo.suggestions (read)  { limit? } → { recent, development, root }
 *   projects.repo.graph       (read)  { projectId? | path?, expand?, maxNodes?, fresh? } → RepoGraph
 *   projects.repo.file        (read)  { projectId? | root?, path } → RepoFileRead
 *   projects.repo.attach      (write) { projectId, path, projectName? } → { projectId, repo }
 *   projects.repo.detach      (write) { projectId } → { projectId, detached }
 *
 * Deploy branch + branch health (see src/projects/repos/*):
 *   projects.repo.repos.list        (read)  {} → { repos: RepoSummary[], badge }
 *   projects.repo.deploy.get        (read)  { repoKey|path|projectId, probeRemote? } → { repo, deploy, status }
 *   projects.repo.deployTarget      (read)  same → agent-friendly target + instructions
 *   projects.repo.deploy.suggest    (read)  { repoKey|path|projectId, probeRemote? } → DeploySuggestion
 *   projects.repo.health.get        (read)  { repoKey|path|projectId } → { report, scanning }
 *   projects.repo.cleanup.preview   (read)  { repoKey|…, includeRemote?, only? } → CleanupPlan (dry run)
 *   projects.repo.cleanup.manifests (read)  { repoKey|… } → { manifests }
 *   projects.repo.setup.get         (read)  {} → { setup, scan, github, repos }
 *   projects.repo.github.status     (read)  {} → { installed, authed, account? }
 *   projects.repo.register          (write) { path } → { repo }
 *   projects.repo.deploy.set        (write) { repoKey|path|projectId, branch, worktreePath, target?, command?, notes?, source? }
 *   projects.repo.deploy.clear      (write) { repoKey|… }
 *   projects.repo.deploy.recordDeploy (write) { repoKey|…, at?, sha?, note? }
 *   projects.repo.health.scan       (write) { repoKey|…, sizes?, github?, wait? } → starts a background scan
 *   projects.repo.cleanup.execute   (write) { planId, confirm: true } → { manifest, manifestPath }
 *   projects.repo.cleanup.restore   (write) { repoKey|…, id, includeRemote? } → { manifest }
 *   projects.repo.setup.update      (write) { step?, skipped?, repoKey?, projectId?, dismiss?, reset? }
 *   projects.repo.schedule.set      (write) { daily } → { scan }
 *   projects.repo.clone             (write) { url, dest? } → { path, repo }
 *
 * Persistence: the binding is saved FIRST to the durable registry
 * (<stateDir>/project-repos/registry.json, atomic writes) and the RPC returns
 * right away; the git inspection, the Notion "Project Directory" mirror (via
 * kanban.projects.update, with retries) and deploy detection run in the
 * background and announce themselves with `projects.repo.changed`. Status
 * reads the registry first and falls back to the legacy projectDirectory /
 * githubLocalPath fields only when a project has no registry binding (a
 * detach tombstone suppresses that fallback).
 */

import fs from "node:fs";
import nodePath from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  ensureRepoRecord,
  findBinding,
  readRegistry,
  resolveRepoKeySync,
  setBinding,
  updateRegistry,
  type DeployConfig,
  type RepoBinding,
  type RepoRecord,
} from "../../projects/repos/registry.js";
import { setRepoHealthBroadcaster } from "../../projects/repos/service.js";
import { repoHealthHandlers } from "./project-repos-health.js";
import {
  browseDirectories,
  listRepoSuggestions,
  rememberRecentRepo,
} from "../../projects/repos/browse.js";
import {
  invalidateRepoInfo,
  inspectRepo,
  normalizeRepoPath,
  type RepoInfo,
} from "../../projects/repos/git-info.js";
import {
  invalidateRepoGraph,
  onRepoGraphChanged,
  readRepoFile,
  scanRepoGraph,
  sweepRepoWatchers,
} from "../../projects/repos/graph-scan.js";
import { broadcastKanbanChanged } from "../../tasks/kanban-events.js";
import { getKanbanStore } from "../../tasks/store.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

export const PROJECT_REPOS_READ_METHODS = [
  "projects.repo.status",
  "projects.repo.inspect",
  "projects.repo.browse",
  "projects.repo.suggestions",
  "projects.repo.graph",
  "projects.repo.file",
  "projects.repo.repos.list",
  "projects.repo.deploy.get",
  "projects.repo.deployTarget",
  "projects.repo.deploy.suggest",
  "projects.repo.health.get",
  "projects.repo.cleanup.preview",
  "projects.repo.cleanup.manifests",
  "projects.repo.setup.get",
  "projects.repo.github.status",
] as const;

export const PROJECT_REPOS_WRITE_METHODS = [
  "projects.repo.attach",
  "projects.repo.detach",
  "projects.repo.register",
  "projects.repo.deploy.set",
  "projects.repo.deploy.clear",
  "projects.repo.deploy.recordDeploy",
  "projects.repo.health.scan",
  "projects.repo.cleanup.execute",
  "projects.repo.cleanup.restore",
  "projects.repo.setup.update",
  "projects.repo.schedule.set",
  "projects.repo.clone",
] as const;

export interface ProjectRepo extends RepoInfo {
  projectId: string;
  projectName: string;
  /** Where the binding came from: the durable registry or a legacy field. */
  source: "registry" | "projectDirectory" | "githubLocalPath";
  /** Repo common-dir key (shared by every worktree of the repo). */
  repoKey?: string;
  /** Deploy branch of the repo, when set. */
  deploy?: Pick<DeployConfig, "branch" | "worktreePath" | "target" | "source" | "confidence">;
  /** Binding revision (registry). */
  rev?: number;
  /** True while the background git inspection has not finished. */
  scanning?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Call a kanban.* handler in-process (same data + Notion path as the UI). */
async function callKanban<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { kanbanHandlers } = await import("./kanban.js");
  const handler = kanbanHandlers[method];
  if (!handler) throw new Error(`no handler for ${method}`);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => {
      if (settled) return;
      settled = true;
      const errText = (payload as { error?: string } | undefined)?.error;
      if (ok && !errText) resolve(payload as T);
      else reject(new Error(error?.message ?? errText ?? `${method} failed`));
    };
    Promise.resolve(
      handler({
        req: { type: "req", id: `project-repos-${Date.now()}`, method, params } as never,
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: respond as never,
        context: undefined as never,
      }),
    ).catch((err) => respond(false, undefined, { message: String(err?.message ?? err) }));
  });
}

interface ProjectRow {
  id: string;
  name: string;
  path?: string;
  source?: ProjectRepo["source"];
  binding?: RepoBinding;
}

/** The kanban project list (cached briefly — Notion can be slow). */
let projectListCache: { at: number; rows: Array<Record<string, unknown>> } | null = null;
const PROJECT_LIST_TTL_MS = 20_000;

async function listProjectsRaw(fresh = false): Promise<Array<Record<string, unknown>>> {
  if (!fresh && projectListCache && Date.now() - projectListCache.at < PROJECT_LIST_TTL_MS) {
    return projectListCache.rows;
  }
  const raw = await callKanban<unknown>("kanban.projects.list", { includeArchived: true });
  const rows = (
    Array.isArray(raw) ? raw : ((raw as { projects?: unknown[] })?.projects ?? [])
  ) as Array<Record<string, unknown>>;
  projectListCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Projects with a bound directory. Registry bindings win; the legacy
 * projectDirectory / githubLocalPath fields are only a fallback. When the
 * kanban list is unavailable (Notion down) registry bindings still resolve.
 */
export async function listBoundProjects(opts: { fresh?: boolean } = {}): Promise<ProjectRow[]> {
  const reg = readRegistry(resolveStateDir());
  let list: Array<Record<string, unknown>> = [];
  let listOk = true;
  try {
    list = await listProjectsRaw(opts.fresh);
  } catch {
    listOk = false;
  }
  let meta: Record<string, { githubLocalPath?: string }> = {};
  try {
    meta = getKanbanStore().getAllProjectMeta();
  } catch {
    /* meta table unavailable */
  }
  const rows: ProjectRow[] = [];
  const seen = new Set<string>();
  const remaps: Array<{ from: string; to: string }> = [];
  for (const p of list) {
    if (typeof p.id !== "string") continue;
    const id = p.id;
    const name = str(p.name) ?? str(p.title) ?? id;
    const binding = findBinding(reg, id, name) ?? undefined;
    if (binding && binding.projectId !== id) remaps.push({ from: binding.projectId, to: id });
    if (binding) seen.add(binding.projectId);
    const dir = str(p.projectDirectory) ?? str(p.directory);
    const gh = str(p.githubLocalPath) ?? str(meta[id]?.githubLocalPath);
    if (binding?.path) {
      rows.push({ id, name, path: binding.path, source: "registry", binding });
      continue;
    }
    const legacy = dir ?? gh;
    // A detach tombstone hides the legacy path it detached (not a new one).
    const hidden =
      binding && !binding.path && legacy && normalizeRepoPath(legacy) === binding.detachedPath;
    rows.push({
      id,
      name,
      path: hidden ? undefined : legacy,
      source: hidden ? undefined : dir ? "projectDirectory" : gh ? "githubLocalPath" : undefined,
      binding,
    });
  }
  // Bindings whose project is not in the list (list failed or still syncing).
  for (const b of Object.values(reg.bindings)) {
    if (seen.has(b.projectId) || !b.path) continue;
    // With a healthy list, an unknown project was deleted — unless it was
    // attached moments ago and the list has not caught up yet.
    if (listOk && list.length > 0 && Date.now() - b.updatedAt > 10 * 60_000) continue;
    rows.push({
      id: b.projectId,
      name: b.projectName,
      path: b.path,
      source: "registry",
      binding: b,
    });
  }
  if (remaps.length) {
    void updateRegistry(resolveStateDir(), (r) => {
      for (const m of remaps) {
        const b = r.bindings[m.from];
        if (b && !r.bindings[m.to]) {
          r.bindings[m.to] = { ...b, projectId: m.to };
          delete r.bindings[m.from];
        }
      }
    }).catch(() => undefined);
  }
  return rows;
}

function deploySummary(rec: RepoRecord | undefined): ProjectRepo["deploy"] {
  const d = rec?.deploy;
  return d
    ? {
        branch: d.branch,
        worktreePath: d.worktreePath,
        target: d.target,
        source: d.source,
        confidence: d.confidence,
      }
    : undefined;
}

async function projectRepo(row: ProjectRow, fresh = false): Promise<ProjectRepo | null> {
  if (!row.path || !row.source) return null;
  // Only absolute/home paths are local checkouts (federation projects may
  // hold e.g. "C:\\Projects\\x" for another node).
  if (!row.path.startsWith("/") && !row.path.startsWith("~")) return null;
  const info = await inspectRepo(row.path, { fresh });
  const reg = readRegistry(resolveStateDir());
  const key = resolveRepoKeySync(row.path)?.key;
  return {
    ...info,
    projectId: row.id,
    projectName: row.name,
    source: row.source,
    repoKey: key,
    deploy: deploySummary(key ? reg.repos[key] : undefined),
    rev: row.binding?.rev,
  };
}

async function findProject(projectId: string): Promise<ProjectRow> {
  let rows = await listBoundProjects();
  let row = rows.find((r) => r.id === projectId);
  if (!row) {
    rows = await listBoundProjects({ fresh: true });
    row = rows.find((r) => r.id === projectId);
  }
  if (!row) throw new Error(`unknown project: ${projectId}`);
  return row;
}

/**
 * Mirror a binding into the project's "Project Directory" field (Notion +
 * local) in the background, retrying with backoff. The registry is already
 * the source of truth, so a failure here never loses the attachment.
 */
function mirrorProjectDirectory(projectId: string, dir: string, rev: number): void {
  void (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      // A newer attach/detach superseded this one.
      const cur = readRegistry(resolveStateDir()).bindings[projectId];
      if (!cur || cur.rev !== rev) return;
      try {
        await updateProjectDirectory(projectId, dir);
        projectListCache = null;
        await updateRegistry(resolveStateDir(), (r) => {
          const b = r.bindings[projectId];
          if (b && b.rev === rev) b.mirrored = true;
        });
        return;
      } catch {
        await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt).unref?.());
      }
    }
  })();
}

/** In-process kanban.projects.update so Notion + local mirror stay in lockstep. */
async function updateProjectDirectory(projectId: string, dir: string): Promise<void> {
  await callKanban("kanban.projects.update", { id: projectId, projectDirectory: dir });
  // Notion-mode updates only PATCH Notion; mirror locally right away so the
  // badge does not wait for the next pull.
  try {
    await getKanbanStore().updateProject(projectId, { projectDirectory: dir || undefined });
  } catch {
    /* local mirror best-effort */
  }
}

let watcherWired = false;
let sweepTimer: NodeJS.Timeout | null = null;

function wireWatcher(context?: GatewayRequestContext): void {
  if (!context?.broadcast) return;
  setRepoHealthBroadcaster(context.broadcast);
  if (!watcherWired) {
    watcherWired = true;
    onRepoGraphChanged((root) => {
      invalidateRepoInfo(root);
      context.broadcast("projects.repo.changed", { root, reason: "fs" }, { dropIfSlow: true });
    });
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => sweepRepoWatchers(), 5 * 60_000);
    sweepTimer.unref?.();
  }
}

function fail(respond: RespondFn, e: unknown, code = "BAD_REQUEST") {
  respond(false, undefined, { code, message: e instanceof Error ? e.message : String(e) });
}

async function resolveRoot(p: Record<string, unknown>): Promise<string> {
  const projectId = str(p.projectId);
  if (projectId) {
    const row = await findProject(projectId);
    if (!row.path) throw new Error("project has no repo attached");
    return row.path;
  }
  const root = str(p.root) ?? str(p.path);
  if (!root) throw new Error("projectId or path is required");
  return root;
}

export const projectReposHandlers: GatewayRequestHandlers = {
  "projects.repo.status": async ({ params, respond, context }) => {
    try {
      wireWatcher(context);
      const p = asRecord(params);
      const wanted = Array.isArray(p.projectIds)
        ? new Set(p.projectIds.filter((x): x is string => typeof x === "string"))
        : null;
      const rows = (await listBoundProjects()).filter(
        (r) => r.path && (!wanted || wanted.has(r.id)),
      );
      const repos: Record<string, ProjectRepo> = {};
      await Promise.all(
        rows.map(async (r) => {
          const repo = await projectRepo(r, p.fresh === true);
          if (repo?.isRepo) repos[r.id] = repo;
        }),
      );
      respond(true, { repos, checkedAt: Date.now() });
    } catch (e) {
      fail(respond, e, "INTERNAL_ERROR");
    }
  },

  "projects.repo.inspect": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const path = str(p.path);
      if (!path) throw new Error("path is required");
      respond(true, await inspectRepo(path, { fresh: p.fresh === true }));
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.browse": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      respond(
        true,
        await browseDirectories({ path: str(p.path), showHidden: p.showHidden === true }),
      );
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.suggestions": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      respond(
        true,
        await listRepoSuggestions(resolveStateDir(), {
          limit: typeof p.limit === "number" ? p.limit : undefined,
        }),
      );
    } catch (e) {
      fail(respond, e, "INTERNAL_ERROR");
    }
  },

  "projects.repo.graph": async ({ params, respond, context }) => {
    try {
      wireWatcher(context);
      const p = asRecord(params);
      const root = await resolveRoot(p);
      const graph = await scanRepoGraph(root, {
        expand: Array.isArray(p.expand) ? (p.expand as string[]) : undefined,
        maxNodes: typeof p.maxNodes === "number" ? p.maxNodes : undefined,
        fresh: p.fresh === true,
        secureRoots: [resolveStateDir()],
      });
      respond(true, { ...graph, projectId: str(p.projectId) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.file": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rel = str(p.path) ?? str(p.file);
      if (!rel) throw new Error("path is required");
      const projectId = str(p.projectId);
      const root = projectId ? await resolveRoot({ projectId }) : str(p.root);
      if (!root) throw new Error("projectId or root is required");
      respond(true, await readRepoFile(root, rel, { secureRoots: [resolveStateDir()] }));
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.attach": async ({ params, respond, context }) => {
    try {
      wireWatcher(context);
      const p = asRecord(params);
      const projectId = str(p.projectId);
      const rawPath = str(p.path);
      if (!projectId) throw new Error("projectId is required");
      if (!rawPath) throw new Error("path is required");
      // fs-only validation (no git spawn) so the save is instant.
      const resolved = resolveRepoKeySync(rawPath);
      if (!resolved)
        throw new Error(`${normalizeRepoPath(rawPath)} is not a git repository (no .git)`);
      let projectName = str(p.projectName);
      if (!projectName) projectName = (await findProject(projectId)).name;
      const root = resolved.root;
      const binding = await updateRegistry(resolveStateDir(), (reg) => {
        ensureRepoRecord(reg, root);
        return setBinding(reg, {
          projectId,
          projectName: projectName as string,
          path: root,
          repoKey: resolved.key,
        });
      });
      const reg = readRegistry(resolveStateDir());
      const repo: ProjectRepo = {
        path: root,
        root,
        isRepo: true,
        name: nodePath.basename(root),
        worktree: fs.statSync(nodePath.join(root, ".git")).isFile(),
        checkedAt: Date.now(),
        projectId,
        projectName,
        source: "registry",
        repoKey: resolved.key,
        deploy: deploySummary(reg.repos[resolved.key]),
        rev: binding.rev,
        scanning: true,
      };
      respond(true, { projectId, repo, rev: binding.rev });
      context?.broadcast?.("projects.repo.changed", {
        projectId,
        root,
        reason: "attach",
        rev: binding.rev,
      });
      // Heavy work in the background.
      void (async () => {
        rememberRecentRepo(resolveStateDir(), root);
        invalidateRepoInfo(root);
        invalidateRepoGraph(root);
        await inspectRepo(root, { fresh: true }).catch(() => undefined);
        mirrorProjectDirectory(projectId, root, binding.rev);
        broadcastKanbanChanged({ entity: "project", op: "update", id: projectId });
        context?.broadcast?.("projects.repo.changed", {
          projectId,
          root,
          reason: "inspected",
          rev: binding.rev,
        });
      })();
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.detach": async ({ params, respond, context }) => {
    try {
      wireWatcher(context);
      const p = asRecord(params);
      const projectId = str(p.projectId);
      if (!projectId) throw new Error("projectId is required");
      const reg0 = readRegistry(resolveStateDir());
      const known = findBinding(reg0, projectId, str(p.projectName));
      const row = known
        ? {
            id: projectId,
            name: known.projectName,
            path: known.path ?? undefined,
            source: "registry" as const,
          }
        : await findProject(projectId);
      const binding = await updateRegistry(resolveStateDir(), (reg) => {
        const b = setBinding(reg, { projectId, projectName: row.name, path: null });
        // Tombstone the legacy path too, so the fallback cannot resurrect it.
        if (row.path && !b.detachedPath) b.detachedPath = normalizeRepoPath(row.path);
        return b;
      });
      respond(true, { projectId, detached: Boolean(row.path), rev: binding.rev });
      context?.broadcast?.("projects.repo.changed", {
        projectId,
        reason: "detach",
        rev: binding.rev,
      });
      void (async () => {
        mirrorProjectDirectory(projectId, "", binding.rev);
        // A githubLocalPath binding belongs to GitHub sync; clear it explicitly.
        if (row.source === "githubLocalPath" || p.clearGithubLocalPath === true) {
          try {
            getKanbanStore().setProjectMeta(projectId, { githubLocalPath: null });
          } catch {
            /* ignore */
          }
        }
        broadcastKanbanChanged({ entity: "project", op: "update", id: projectId });
      })();
    } catch (e) {
      fail(respond, e);
    }
  },

  ...repoHealthHandlers,
};

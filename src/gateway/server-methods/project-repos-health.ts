/**
 * Project repos — deploy branch, branch health, safe cleanup and first-time
 * setup RPCs. Registered through `projectReposHandlers` (project-repos.ts);
 * the method lists live there too.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { developmentRoot } from "../../projects/repos/browse.js";
import {
  executeCleanup,
  getCleanupPlan,
  listManifests,
  previewCleanup,
  restoreCleanup,
} from "../../projects/repos/cleanup.js";
import { deployStatus, suggestDeploy } from "../../projects/repos/deploy-detect.js";
import { normalizeRepoPath } from "../../projects/repos/git-info.js";
import {
  readRegistry,
  SETUP_STEPS,
  updateRegistry,
  type DeployConfig,
  type DeployTargetKind,
  type RepoRecord,
  type SetupStep,
} from "../../projects/repos/registry.js";
import {
  broadcastRepos,
  deployTargetFor,
  readHealthReport,
  registerRepo,
  resolveRepoFromRegistry,
  scanJob,
  startHealthScan,
  type RepoRef,
} from "../../projects/repos/service.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function fail(respond: RespondFn, e: unknown, code = "BAD_REQUEST") {
  respond(false, undefined, { code, message: e instanceof Error ? e.message : String(e) });
}

function refOf(p: Record<string, unknown>): RepoRef {
  return { repoKey: str(p.repoKey), path: str(p.path) ?? str(p.root), projectId: str(p.projectId) };
}

/** Resolve the params to a registered repo, registering it on first use. */
async function repoFor(
  p: Record<string, unknown>,
  opts: { register?: boolean } = {},
): Promise<RepoRecord> {
  const ref = refOf(p);
  const reg = readRegistry(resolveStateDir());
  const r = resolveRepoFromRegistry(reg, ref);
  if (!r) {
    if (ref.projectId && !ref.path) throw new Error("project has no repo attached");
    throw new Error("repoKey, path or projectId is required (and must be a git repository)");
  }
  if (r.record) return r.record;
  if (opts.register === false) throw new Error(`${r.root} is not registered`);
  return await registerRepo(r.checkout);
}

const TARGET_KINDS: DeployTargetKind[] = ["fly", "netlify", "vercel", "gateway", "docker", "other"];

function ghStatus(): Promise<{
  installed: boolean;
  authed: boolean;
  account?: string;
  detail?: string;
}> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      { timeout: 8000 },
      (err, stdout, stderr) => {
        const text = `${stdout ?? ""}${stderr ?? ""}`;
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return resolve({
            installed: false,
            authed: false,
            detail: "GitHub CLI (gh) is not installed",
          });
        }
        const account = text.match(/account (\S+)/)?.[1] ?? text.match(/as (\S+)/)?.[1];
        resolve({
          installed: true,
          authed: !err && /Logged in/i.test(text),
          account,
          detail: err ? "Run `gh auth login` in a terminal to connect GitHub" : undefined,
        });
      },
    );
  });
}

function summary(rec: RepoRecord) {
  const report = readHealthReport(rec);
  return {
    key: rec.key,
    name: rec.name,
    root: rec.root,
    addedAt: rec.addedAt,
    deploy: rec.deploy ?? null,
    lastHealth: rec.lastHealth ?? (report ? { at: report.scannedAt, totals: report.totals } : null),
    scanning: scanJob(rec.key),
    exists: fs.existsSync(rec.root),
  };
}

export const repoHealthHandlers: GatewayRequestHandlers = {
  "projects.repo.repos.list": async ({ respond }) => {
    try {
      const reg = readRegistry(resolveStateDir());
      // Attached repos are registered implicitly.
      const missing = Object.values(reg.bindings)
        .filter((b) => b.path)
        .map((b) => resolveRepoFromRegistry(reg, { path: b.path as string }))
        .filter((r) => r && !r.record);
      if (missing.length) {
        for (const r of missing) if (r) await registerRepo(r.checkout).catch(() => undefined);
      }
      const fresh = readRegistry(resolveStateDir());
      const repos = Object.values(fresh.repos)
        .map(summary)
        .sort((a, b) => a.name.localeCompare(b.name));
      const projects: Record<string, string[]> = {};
      for (const b of Object.values(fresh.bindings)) {
        if (!b.path) continue;
        const r = resolveRepoFromRegistry(fresh, { path: b.path });
        if (r) (projects[r.key] ??= []).push(b.projectName);
      }
      const badge = repos.reduce(
        (n, r) => n + (r.lastHealth?.totals.safe ?? 0) + (r.lastHealth?.totals.worktreesSafe ?? 0),
        0,
      );
      respond(true, { repos, projects, badge, scan: fresh.scan, setup: fresh.setup });
    } catch (e) {
      fail(respond, e, "INTERNAL_ERROR");
    }
  },

  "projects.repo.register": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const at = str(p.path);
      if (!at) throw new Error("path is required");
      const rec = await registerRepo(normalizeRepoPath(at));
      broadcastRepos("projects.repo.changed", { repoKey: rec.key, reason: "register" });
      respond(true, { repo: summary(rec) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.deploy.get": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p);
      const status = rec.deploy
        ? await deployStatus(rec.deploy, { probeRemote: p.probeRemote === true })
        : undefined;
      respond(true, { repo: summary(rec), deploy: rec.deploy ?? null, status: status ?? null });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.deployTarget": async ({ params, respond }) => {
    try {
      const info = await deployTargetFor(refOf(asRecord(params)));
      if (!info) throw new Error("no repo found for that repoKey / path / projectId");
      respond(true, info);
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.deploy.suggest": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p);
      respond(
        true,
        await suggestDeploy(rec.root, {
          probeRemote: p.probeRemote !== false,
          current: rec.deploy,
          liveStateDir: resolveStateDir(),
        }),
      );
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.deploy.set": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p);
      const branch = str(p.branch);
      const worktreePath = str(p.worktreePath);
      if (!branch) throw new Error("branch is required");
      if (!worktreePath) throw new Error("worktreePath is required");
      const wt = normalizeRepoPath(worktreePath);
      if (!fs.existsSync(wt)) throw new Error(`folder does not exist: ${wt}`);
      const t = asRecord(p.target);
      const kind = str(t.kind) as DeployTargetKind | undefined;
      const cfg: DeployConfig = {
        branch,
        worktreePath: wt,
        target: kind && TARGET_KINDS.includes(kind) ? { kind, name: str(t.name) } : undefined,
        command: str(p.command),
        notes: str(p.notes),
        source: p.source === "auto" ? "auto" : "manual",
        confidence: typeof p.confidence === "number" ? p.confidence : undefined,
        confirmedAt: Date.now(),
        updatedAt: Date.now(),
        deploys: rec.deploy?.deploys,
      };
      const saved = await updateRegistry(resolveStateDir(), (reg) => {
        const r = reg.repos[rec.key];
        if (!r) throw new Error("repo vanished from the registry");
        r.deploy = cfg;
        r.updatedAt = Date.now();
        return r;
      });
      broadcastRepos("projects.repo.changed", { repoKey: rec.key, reason: "deploy" });
      respond(true, { repo: summary(saved), deploy: cfg, status: await deployStatus(cfg) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.deploy.clear": async ({ params, respond }) => {
    try {
      const rec = await repoFor(asRecord(params), { register: false });
      await updateRegistry(resolveStateDir(), (reg) => {
        const r = reg.repos[rec.key];
        if (r) delete r.deploy;
      });
      broadcastRepos("projects.repo.changed", { repoKey: rec.key, reason: "deploy" });
      respond(true, { repoKey: rec.key, cleared: true });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.deploy.recordDeploy": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p, { register: false });
      const entry = {
        at: typeof p.at === "number" ? p.at : Date.now(),
        sha: str(p.sha),
        note: str(p.note),
      };
      await updateRegistry(resolveStateDir(), (reg) => {
        const d = reg.repos[rec.key]?.deploy;
        if (!d) throw new Error("set a deploy branch first");
        d.deploys = [entry, ...(d.deploys ?? [])].slice(0, 20);
      });
      broadcastRepos("projects.repo.changed", { repoKey: rec.key, reason: "deploy" });
      respond(true, { repoKey: rec.key, deploy: entry });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.health.get": async ({ params, respond }) => {
    try {
      const rec = await repoFor(asRecord(params));
      respond(true, {
        repo: summary(rec),
        report: readHealthReport(rec),
        scanning: scanJob(rec.key),
      });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.health.scan": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p);
      const job = startHealthScan(rec, { sizes: p.sizes !== false, github: p.github !== false });
      if (p.wait === true) {
        const report = await job;
        respond(true, {
          repo: summary(readRegistry(resolveStateDir()).repos[rec.key] ?? rec),
          report,
          scanning: null,
        });
        return;
      }
      respond(true, { started: true, repoKey: rec.key, scanning: scanJob(rec.key) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.cleanup.preview": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p, { register: false });
      const includeRemote = Array.isArray(p.includeRemote)
        ? p.includeRemote.filter((x): x is string => typeof x === "string")
        : [];
      const only = Array.isArray(p.only)
        ? p.only.filter((x): x is string => typeof x === "string")
        : undefined;
      // A fresh scan backs every preview; it also refreshes the cached report.
      const report = await startHealthScan(rec, { sizes: true, github: p.github !== false });
      const plan = await previewCleanup(rec.root, {
        deployBranch: rec.deploy?.branch,
        deployWorktreePath: rec.deploy?.worktreePath,
        includeRemote,
        only,
        report,
      });
      respond(true, { plan, repoKey: rec.key });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.cleanup.execute": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const planId = str(p.planId);
      if (!planId) throw new Error("planId is required (run projects.repo.cleanup.preview first)");
      if (p.confirm !== true) throw new Error("confirm: true is required");
      const plan = getCleanupPlan(planId);
      if (!plan) throw new Error("cleanup plan expired — run the preview again");
      const out = await executeCleanup(resolveStateDir(), planId, { confirm: true });
      const reg = readRegistry(resolveStateDir());
      const rec = Object.values(reg.repos).find(
        (r) => path.resolve(r.root) === path.resolve(plan.repoRoot),
      );
      if (rec) void startHealthScan(rec, { sizes: true, github: false }).catch(() => undefined);
      broadcastRepos("projects.repo.changed", { repoKey: rec?.key, reason: "cleanup" });
      respond(true, out);
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.cleanup.manifests": async ({ params, respond }) => {
    try {
      const rec = await repoFor(asRecord(params), { register: false });
      respond(true, { repoKey: rec.key, manifests: listManifests(resolveStateDir(), rec.name) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.cleanup.restore": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const rec = await repoFor(p, { register: false });
      const id = str(p.id);
      if (!id) throw new Error("id is required");
      const manifest = await restoreCleanup(resolveStateDir(), rec.name, id, {
        includeRemote: p.includeRemote === true,
      });
      void startHealthScan(rec, { sizes: true, github: false }).catch(() => undefined);
      broadcastRepos("projects.repo.changed", { repoKey: rec.key, reason: "restore" });
      respond(true, { manifest });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.setup.get": async ({ respond }) => {
    try {
      const reg = readRegistry(resolveStateDir());
      respond(true, {
        setup: reg.setup,
        scan: reg.scan,
        steps: SETUP_STEPS,
        repos: Object.values(reg.repos).map(summary),
        developmentRoot: developmentRoot(),
      });
    } catch (e) {
      fail(respond, e, "INTERNAL_ERROR");
    }
  },

  "projects.repo.github.status": async ({ respond }) => {
    respond(true, await ghStatus());
  },

  "projects.repo.setup.update": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const setup = await updateRegistry(resolveStateDir(), (reg) => {
        if (p.reset === true) reg.setup = { steps: {} };
        const step = str(p.step) as SetupStep | undefined;
        if (step) {
          if (!SETUP_STEPS.includes(step)) throw new Error(`unknown step: ${step}`);
          reg.setup.steps[step] = { at: Date.now(), skipped: p.skipped === true || undefined };
          if (step === "done") reg.setup.completedAt = Date.now();
        }
        if (str(p.repoKey)) reg.setup.repoKey = str(p.repoKey);
        if (str(p.projectId)) reg.setup.projectId = str(p.projectId);
        if (p.dismiss === true) reg.setup.dismissedAt = Date.now();
        reg.setup.updatedAt = Date.now();
        return reg.setup;
      });
      respond(true, { setup });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.schedule.set": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const scan = await updateRegistry(resolveStateDir(), (reg) => {
        reg.scan.daily = p.daily === true;
        return reg.scan;
      });
      respond(true, { scan });
    } catch (e) {
      fail(respond, e);
    }
  },

  "projects.repo.clone": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const url = str(p.url);
      if (!url) throw new Error("url is required");
      if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(url)) {
        throw new Error("only https://, ssh:// or git@ URLs can be cloned");
      }
      const name =
        url
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .pop() || "repo";
      const dest = normalizeRepoPath(str(p.dest) ?? path.join(developmentRoot(), name));
      if (fs.existsSync(dest))
        throw new Error(`${dest} already exists — pick it as a folder instead`);
      await new Promise<void>((resolve, reject) => {
        execFile(
          "git",
          ["clone", "--", url, dest],
          { timeout: 15 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
          (err, _o, stderr) =>
            err
              ? reject(
                  new Error(
                    String(stderr || err.message)
                      .trim()
                      .slice(0, 400),
                  ),
                )
              : resolve(),
        );
      });
      const rec = await registerRepo(dest);
      respond(true, { path: dest, repo: summary(rec) });
    } catch (e) {
      fail(respond, e);
    }
  },
};

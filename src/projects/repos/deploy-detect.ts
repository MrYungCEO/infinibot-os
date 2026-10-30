/**
 * Deploy branch — suggestion engine + live status of the deploy checkout.
 *
 * Signals (each adds to a candidate's score; confidence = score / 100,
 * capped at 0.97):
 *   gateway   a running InfiniBot gateway serves from this worktree     +60
 *   netlify   `.netlify/state.json` in the worktree (CLI deployed it)    +35
 *   ci        a workflow deploys on push to this branch                  +40
 *   fly       last `fly releases` time matches this worktree's HEAD      +25
 *   release   newest release/* or deploy/* branch                        +25
 *   checkout  that branch is checked out in a worktree                   +10
 *   default   the default branch (origin/HEAD)                           +15
 * Targets come from fly*.toml (app name), netlify.toml, vercel.json and the
 * gateway process. Everything is read-only; `fly releases` only runs when
 * `probeRemote` is set and flyctl is installed.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  defaultBranchOf,
  listWorktrees,
  resolveBranchRef,
  type RawWorktree,
} from "./branch-health.js";
import { isReleaseName } from "./classify.js";
import { runGit } from "./git-info.js";
import type { DeployConfig, DeployTarget } from "./registry.js";

export interface DeploySignal {
  kind: "gateway" | "netlify" | "ci" | "fly" | "release" | "checkout" | "default" | "configured";
  detail: string;
  weight: number;
}

export interface DeployCandidate {
  branch: string;
  worktreePath?: string;
  target?: DeployTarget;
  command?: string;
  score: number;
  confidence: number;
  signals: DeploySignal[];
}

export interface DeploySuggestion {
  root: string;
  defaultBranch?: string;
  best?: DeployCandidate;
  candidates: DeployCandidate[];
  targets: Array<DeployTarget & { file?: string; command?: string }>;
  lastRelease?: { at: number; version?: number; app: string };
  checkedAt: number;
}

export interface DeployStatus {
  branch: string;
  worktreePath: string;
  exists: boolean;
  /** Branch actually checked out in the deploy folder. */
  checkedOutBranch?: string;
  onDeployBranch: boolean;
  headSha?: string;
  headSubject?: string;
  headAt?: number;
  dirty: boolean;
  dirtyCount: number;
  /** Compared against the upstream, else origin/<branch> (no fetch). */
  originRef?: string;
  ahead?: number;
  behind?: number;
  /** When origin was last fetched (FETCH_HEAD mtime). */
  fetchedAt?: number;
  lastDeploy?: { at: number; source: "fly" | "gateway" | "manual"; detail?: string };
  checkedAt: number;
}

const MAX_TOML_DEPTH = 3;

function readSafe(file: string, max = 256 * 1024): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** fly*.toml files at depth ≤ 3, skipping node_modules / dot dirs. */
function findFlyTomls(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_TOML_DEPTH || out.length > 20) return out;
  let ents: fs.Dirent[] = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.isFile() && /^fly(\.[\w-]+)?\.toml$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    if (/^(dist|build|out|coverage|vendor|target)$/.test(e.name)) continue;
    // Only descend into likely infra folders below the top level.
    if (depth >= 1 && !/^(deploy|deployment|infra|fly|ops|config)$/i.test(e.name)) continue;
    findFlyTomls(path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

export function detectTargets(
  dir: string,
): Array<DeployTarget & { file?: string; command?: string }> {
  const out: Array<DeployTarget & { file?: string; command?: string }> = [];
  for (const file of findFlyTomls(dir)) {
    const app = readSafe(file)?.match(/^\s*app\s*=\s*["']([^"']+)["']/m)?.[1];
    if (!app) continue;
    const rel = path.relative(dir, file);
    out.push({
      kind: "fly",
      name: app,
      file: rel,
      command: rel === "fly.toml" ? "fly deploy" : `fly deploy -c ${rel}`,
    });
  }
  if (fs.existsSync(path.join(dir, "netlify.toml"))) {
    out.push({
      kind: "netlify",
      name: netlifySite(dir),
      file: "netlify.toml",
      command: "netlify deploy --prod",
    });
  }
  if (fs.existsSync(path.join(dir, "vercel.json"))) {
    out.push({ kind: "vercel", file: "vercel.json", command: "vercel --prod" });
  }
  return out;
}

function netlifySite(dir: string): string | undefined {
  const raw = readSafe(path.join(dir, ".netlify", "state.json"));
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as { siteId?: string }).siteId;
  } catch {
    return undefined;
  }
}

/** Branches CI deploys on push (workflows that mention a deploy command). */
export function ciDeployBranches(
  dir: string,
): Array<{ branch: string; file: string; tool: string }> {
  const wfDir = path.join(dir, ".github", "workflows");
  let files: string[] = [];
  try {
    files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return [];
  }
  const out: Array<{ branch: string; file: string; tool: string }> = [];
  for (const f of files) {
    const raw = readSafe(path.join(wfDir, f));
    if (!raw) continue;
    const tool = raw.match(
      /\b(flyctl deploy|fly deploy|superfly\/flyctl-actions|netlify deploy|nwtgck\/actions-netlify|vercel --prod|amondnet\/vercel-action|docker push|gh release)\b/,
    )?.[1];
    if (!tool) continue;
    let doc: unknown;
    try {
      doc = YAML.parse(raw);
    } catch {
      continue;
    }
    const on = (doc as { on?: unknown; true?: unknown })?.on ?? (doc as { true?: unknown })?.true;
    const push = (on as { push?: { branches?: unknown } } | undefined)?.push;
    const branches = Array.isArray(push?.branches) ? push.branches : [];
    for (const b of branches) {
      if (typeof b === "string" && !b.includes("*")) out.push({ branch: b, file: f, tool });
    }
  }
  return out;
}

export interface GatewayDir {
  dir: string;
  /** "self" = the gateway answering this call; "live" = same state dir; "side" = any other. */
  role: "self" | "live" | "side";
}

/** Folders running InfiniBot gateways serve from (cwd of the process). */
export function runningGatewayDirs(liveStateDir?: string): GatewayDir[] {
  const out = new Map<string, GatewayDir>();
  const put = (dir: string, role: GatewayDir["role"]) => {
    const rank = { self: 3, live: 2, side: 1 } as const;
    const cur = out.get(dir);
    if (!cur || rank[role] > rank[cur.role]) out.set(dir, { dir, role });
  };
  if (/infinibot/i.test(process.title) || process.argv.slice(1).some((a) => a === "gateway")) {
    put(path.resolve(process.cwd()), "self");
  }
  if (process.platform !== "linux") return [...out.values()];
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [...out.values()];
  }
  const home = os.homedir();
  const live = path.resolve(liveStateDir ?? path.join(home, ".infinibot"));
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!/^infinibot-gateway\b/.test(cmd)) continue;
      const dir = path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`));
      let stateDir = path.join(home, ".infinibot");
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        const sd = env.find((e) => e.startsWith("INFINIBOT_STATE_DIR="));
        if (sd) stateDir = sd.slice("INFINIBOT_STATE_DIR=".length);
      } catch {
        /* unreadable environ → assume default */
      }
      put(dir, path.resolve(stateDir) === live ? "live" : "side");
    } catch {
      /* gone / not ours */
    }
  }
  return [...out.values()];
}

function flyBin(): string | null {
  for (const p of [
    path.join(os.homedir(), ".fly", "bin", "flyctl"),
    "/usr/local/bin/flyctl",
    "/usr/bin/flyctl",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function flyLastRelease(app: string): Promise<{ at: number; version?: number } | null> {
  const bin = flyBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      bin,
      ["releases", "-a", app, "--json"],
      { timeout: 15_000, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list = JSON.parse(String(stdout)) as Array<{
            CreatedAt?: string;
            Version?: number;
            Status?: string;
          }>;
          const done =
            list.find((r) => !r.Status || r.Status === "complete" || r.Status === "succeeded") ??
            list[0];
          if (!done?.CreatedAt) return resolve(null);
          resolve({ at: Date.parse(done.CreatedAt), version: done.Version });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function addSignal(c: DeployCandidate, s: DeploySignal) {
  if (c.signals.some((x) => x.kind === s.kind && x.detail === s.detail)) return;
  c.signals.push(s);
  c.score += s.weight;
}

export async function suggestDeploy(
  rootIn: string,
  opts: { probeRemote?: boolean; current?: DeployConfig; liveStateDir?: string } = {},
): Promise<DeploySuggestion> {
  const top = await runGit(rootIn, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`${rootIn} is not a git repository`);
  const worktrees = await listWorktrees(top.stdout.trim());
  const root = worktrees[0]?.path ?? top.stdout.trim();
  const defaultBranch = await defaultBranchOf(root);
  const cands = new Map<string, DeployCandidate>();
  const byBranchWt = new Map<string, RawWorktree>();
  for (const w of worktrees) if (w.branch && !byBranchWt.has(w.branch)) byBranchWt.set(w.branch, w);
  const cand = (branch: string, worktreePath?: string): DeployCandidate => {
    let c = cands.get(branch);
    if (!c) {
      c = {
        branch,
        worktreePath: worktreePath ?? byBranchWt.get(branch)?.path,
        score: 0,
        confidence: 0,
        signals: [],
      };
      cands.set(branch, c);
    } else if (worktreePath && !c.worktreePath) c.worktreePath = worktreePath;
    return c;
  };

  if (opts.current?.branch) {
    addSignal(cand(opts.current.branch, opts.current.worktreePath), {
      kind: "configured",
      detail: "current setting",
      weight: 5,
    });
  }

  // Running gateway.
  const gwDirs = runningGatewayDirs(opts.liveStateDir);
  for (const w of worktrees) {
    if (!w.branch) continue;
    const gw = gwDirs
      .filter((g) => g.dir === w.path || g.dir.startsWith(w.path + path.sep))
      .sort((a, b) =>
        a.role === "self" ? -1 : a.role === "live" ? (b.role === "self" ? 1 : -1) : 1,
      )[0];
    if (gw) {
      const c = cand(w.branch, w.path);
      const live = gw.role !== "side";
      addSignal(c, {
        kind: "gateway",
        detail: live
          ? `the live InfiniBot gateway serves from ${w.path}`
          : `a side gateway (other state dir) runs from ${w.path}`,
        weight: live ? 60 : 10,
      });
      if (live) {
        c.target ??= { kind: "gateway", name: "InfiniBot gateway" };
        c.command ??=
          "build in a side worktree, fast-forward this branch, rebuild here, then restart the gateway";
      }
    }
    if (/(^|[-_.])(rel|release|deploy|live|prod)([-_.\d]|$)/i.test(path.basename(w.path))) {
      addSignal(cand(w.branch, w.path), {
        kind: "checkout",
        detail: `folder named like a deploy checkout (${path.basename(w.path)})`,
        weight: 5,
      });
    }
    if (fs.existsSync(path.join(w.path, ".netlify", "state.json"))) {
      addSignal(cand(w.branch, w.path), {
        kind: "netlify",
        detail: `Netlify CLI deployed from ${w.path}`,
        weight: 35,
      });
    }
  }

  // Deploy targets (from the main checkout and any worktree that has them).
  const targets: DeploySuggestion["targets"] = [];
  const seenTarget = new Set<string>();
  for (const w of worktrees.slice(0, 80)) {
    if (!fs.existsSync(w.path)) continue;
    for (const t of detectTargets(w.path)) {
      const k = `${t.kind}:${t.name ?? ""}:${t.file ?? ""}`;
      if (seenTarget.has(k)) continue;
      seenTarget.add(k);
      targets.push(t);
    }
  }

  // CI deploy-on-push.
  for (const ci of ciDeployBranches(root)) {
    addSignal(cand(ci.branch), {
      kind: "ci",
      detail: `${ci.file} deploys on push (${ci.tool})`,
      weight: 40,
    });
  }

  // Release naming: newest release/* / deploy/* branch.
  const refs = await runGit(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)\x1f%(committerdate:unix)",
    "refs/heads",
  ]);
  const releases = (refs.ok ? refs.stdout.split("\n") : [])
    .map((l) => l.split("\x1f"))
    .filter(([n]) => n && isReleaseName(n))
    .map(([n, ct]) => ({ name: n, at: Number(ct) * 1000 }));
  if (releases[0]) {
    addSignal(cand(releases[0].name), {
      kind: "release",
      detail: "newest release branch",
      weight: 25,
    });
  }

  // Fly: match the last release time to the worktree whose HEAD commit landed just before it.
  let lastRelease: DeploySuggestion["lastRelease"];
  const fly = targets.find((t) => t.kind === "fly");
  if (fly?.name && opts.probeRemote) {
    const rel = await flyLastRelease(fly.name);
    if (rel) {
      lastRelease = { ...rel, app: fly.name };
      let best: { w: RawWorktree; gap: number } | null = null;
      for (const w of worktrees) {
        if (!w.branch || !fs.existsSync(w.path)) continue;
        const ct =
          Number((await runGit(w.path, ["log", "-1", "--format=%ct"])).stdout.trim()) * 1000;
        if (!ct || ct > rel.at) continue;
        const gap = rel.at - ct;
        if (!best || gap < best.gap) best = { w, gap };
      }
      if (best && best.w.branch && best.gap < 7 * 86_400_000) {
        addSignal(cand(best.w.branch, best.w.path), {
          kind: "fly",
          detail: `last Fly release of ${fly.name} (v${rel.version ?? "?"}) followed this folder's latest commit`,
          weight: isReleaseName(best.w.branch) ? 25 : 10,
        });
      }
    }
  }

  if (defaultBranch)
    addSignal(cand(defaultBranch), { kind: "default", detail: "default branch", weight: 15 });

  for (const c of cands.values()) {
    if (c.worktreePath) {
      addSignal(c, { kind: "checkout", detail: `checked out at ${c.worktreePath}`, weight: 10 });
    }
    if (!c.target && fly) {
      c.target = { kind: "fly", name: fly.name };
      c.command = fly.command;
    } else if (!c.target && targets[0]) {
      c.target = { kind: targets[0].kind, name: targets[0].name };
      c.command = targets[0].command;
    }
    c.confidence = Math.min(0.97, Math.round(c.score) / 100);
  }
  const candidates = [...cands.values()].sort((a, b) => b.score - a.score);
  return {
    root,
    defaultBranch,
    best: candidates[0],
    candidates: candidates.slice(0, 8),
    targets,
    lastRelease,
    checkedAt: Date.now(),
  };
}

export async function deployStatus(
  cfg: Pick<DeployConfig, "branch" | "worktreePath" | "deploys" | "target">,
  opts: { probeRemote?: boolean } = {},
): Promise<DeployStatus> {
  const now = Date.now();
  const base: DeployStatus = {
    branch: cfg.branch,
    worktreePath: cfg.worktreePath,
    exists: fs.existsSync(cfg.worktreePath),
    onDeployBranch: false,
    dirty: false,
    dirtyCount: 0,
    checkedAt: now,
  };
  if (cfg.deploys?.[0])
    base.lastDeploy = { at: cfg.deploys[0].at, source: "manual", detail: cfg.deploys[0].note };
  if (!base.exists) return base;
  const [head, log, status, upstream, gitDir] = await Promise.all([
    runGit(cfg.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(cfg.worktreePath, ["log", "-1", "--format=%H%x1f%s%x1f%ct"]),
    runGit(cfg.worktreePath, ["status", "--porcelain=v1"], { timeoutMs: 15_000 }),
    runGit(cfg.worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    runGit(cfg.worktreePath, ["rev-parse", "--git-common-dir"]),
  ]);
  base.checkedOutBranch = head.ok ? head.stdout.trim() : undefined;
  base.onDeployBranch = base.checkedOutBranch === cfg.branch;
  if (log.ok) {
    const [sha, subject, ct] = log.stdout.trim().split("\x1f");
    base.headSha = sha;
    base.headSubject = subject;
    base.headAt = Number(ct) * 1000;
  }
  if (status.ok) {
    base.dirtyCount = status.stdout.split("\n").filter((l) => l.trim()).length;
    base.dirty = base.dirtyCount > 0;
  }
  let originRef = upstream.ok && upstream.stdout.trim() ? upstream.stdout.trim() : undefined;
  if (!originRef) {
    const r = await resolveBranchRef(cfg.worktreePath, cfg.branch);
    const remote = await runGit(cfg.worktreePath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${cfg.branch}`,
    ]);
    if (remote.ok && r) originRef = `origin/${cfg.branch}`;
  }
  if (originRef) {
    base.originRef = originRef;
    const counts = await runGit(cfg.worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      `${originRef}...HEAD`,
    ]);
    if (counts.ok) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      base.ahead = ahead;
      base.behind = behind;
    }
  }
  if (gitDir.ok) {
    const common = path.resolve(cfg.worktreePath, gitDir.stdout.trim());
    try {
      base.fetchedAt = fs.statSync(path.join(common, "FETCH_HEAD")).mtimeMs;
    } catch {
      /* never fetched */
    }
  }
  if (cfg.target?.kind === "gateway") {
    const started = gatewayStartedAt(cfg.worktreePath);
    if (started && (!base.lastDeploy || started > base.lastDeploy.at)) {
      base.lastDeploy = { at: started, source: "gateway", detail: "gateway process started" };
    }
  } else if (cfg.target?.kind === "fly" && cfg.target.name && opts.probeRemote) {
    const rel = await flyLastRelease(cfg.target.name);
    if (rel && (!base.lastDeploy || rel.at > base.lastDeploy.at)) {
      base.lastDeploy = {
        at: rel.at,
        source: "fly",
        detail: `${cfg.target.name} v${rel.version ?? "?"}`,
      };
    }
  }
  return base;
}

/** Start time of the gateway process serving from `dir` (Linux /proc). */
function gatewayStartedAt(dir: string): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const boot = Number(fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)/m)?.[1] ?? 0);
    const hz = 100;
    let newest: number | undefined;
    for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        if (!/^infinibot-gateway\b/.test(cmd)) continue;
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (path.resolve(cwd) !== path.resolve(dir)) continue;
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const startTicks = Number(fields[19]);
        const at = (boot + startTicks / hz) * 1000;
        if (!newest || at > newest) newest = at;
      } catch {
        /* skip */
      }
    }
    return newest;
  } catch {
    return undefined;
  }
}

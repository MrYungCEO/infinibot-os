/**
 * Branch health — read-only scan of every local + remote branch, worktree
 * and stash of a repo, measured against its deploy branch.
 *
 * "Merged" is proven four ways, cheapest first:
 *   ancestor  `git for-each-ref --merged <deploy>`
 *   cherry    `git cherry <deploy> <branch>` has no "+" lines (rebased /
 *             cherry-picked commits count)
 *   content   every file the branch changed since the merge-base is
 *             byte-identical in the deploy branch (squash-merge, untouched since)
 *   squash    the branch's whole diff has the same `git patch-id` as one
 *             commit on the deploy branch (squash-merge, later edits elsewhere)
 *
 * Never fetches, pulls, checks out or writes; the only network call is an
 * optional `gh pr list` (skipped when gh is missing or not logged in).
 * Merge facts are cached per (branch sha, deploy sha) because they cannot
 * change unless one of the two moves.
 */

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { attributeUsers, collectFolderUsers } from "./activity.js";
import {
  classifyBranch,
  classifyWorktree,
  type BranchFacts,
  type Classification,
  type MergedBy,
  type PullRequestInfo,
  type WorktreeFacts,
} from "./classify.js";
import { remoteSlug, runGit } from "./git-info.js";
import type { HealthTotals } from "./registry.js";

export interface BranchRow extends BranchFacts, Classification {}
export interface WorktreeRow extends WorktreeFacts, Classification {}

export interface StashRow {
  ref: string;
  sha: string;
  message: string;
  branch?: string;
  at: number;
  files: number;
  /** Every file in the stash already matches the deploy branch. */
  inDeploy?: boolean;
}

export interface HealthReport {
  repoKey?: string;
  name: string;
  root: string;
  scannedAt: number;
  durationMs: number;
  deployBranch?: string;
  /** Ref the scan compared against (refs/heads/x or refs/remotes/origin/x). */
  baseRef?: string;
  baseSha?: string;
  /** "deploy" when a deploy branch is set, otherwise "default". */
  comparedAgainst: "deploy" | "default" | "none";
  defaultBranch?: string;
  remoteSlug?: string;
  gh: { available: boolean; authed: boolean; prs: number; error?: string };
  branches: BranchRow[];
  worktrees: WorktreeRow[];
  stashes: StashRow[];
  totals: HealthTotals;
  warnings: string[];
}

export interface ScanOptions {
  deployBranch?: string;
  deployWorktreePath?: string;
  /** Measure worktree disk usage with `du` (slow on big trees). */
  sizes?: boolean;
  /** Ask GitHub (gh) for PR state. */
  github?: boolean;
  now?: number;
  onProgress?: (phase: string, done: number, total: number) => void;
}

const SEP = "\x1f";

function lines(s: string): string[] {
  return s.split("\n").filter((l) => l.trim() !== "");
}

// ── Low-level helpers ────────────────────────────────────────────────

/** `git <a> | git <b>` without buffering the first command's output. */
function gitPipe(
  cwd: string,
  first: string[],
  second: string[],
  timeoutMs = 30_000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
    const a = spawn("git", ["-C", cwd, "--no-optional-locks", ...first], { env });
    const b = spawn("git", ["-C", cwd, ...second], { env });
    let out = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.kill();
      b.kill();
      resolve({ ok, stdout: out });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    a.stdout.pipe(b.stdin);
    a.on("error", () => finish(false));
    b.on("error", () => finish(false));
    b.stdin.on("error", () => {
      /* EPIPE when b exits early */
    });
    b.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    b.on("close", (code) => finish(code === 0));
  });
}

function duBytes(dir: string, timeoutMs = 45_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("du", ["-skx", dir], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const kb = Number(String(stdout).split(/\s+/)[0]);
      // du exits non-zero on unreadable sub-dirs but still prints a total.
      if (Number.isFinite(kb) && kb > 0) resolve(kb * 1024);
      else resolve(err ? undefined : 0);
    });
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ── Worktrees ────────────────────────────────────────────────────────

export interface RawWorktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export async function listWorktrees(root: string): Promise<RawWorktree[]> {
  const res = await runGit(root, ["worktree", "list", "--porcelain"], { timeoutMs: 8000 });
  if (!res.ok) return [];
  const out: RawWorktree[] = [];
  let cur: RawWorktree | null = null;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = {
        path: line.slice(9).trim(),
        head: "",
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
    else if (line.startsWith("branch "))
      cur.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("locked")) cur.locked = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

const sizeCache = new Map<string, { at: number; bytes: number | undefined }>();
const SIZE_TTL_MS = 30 * 60_000;

async function worktreeFacts(
  raw: RawWorktree,
  index: number,
  opts: { sizes: boolean },
): Promise<WorktreeFacts> {
  const missing = !fs.existsSync(raw.path);
  const facts: WorktreeFacts = {
    path: raw.path,
    branch: raw.branch,
    head: raw.head,
    main: index === 0,
    detached: raw.detached,
    bare: raw.bare,
    locked: raw.locked,
    prunable: raw.prunable,
    missing,
    dirty: false,
    dirtyCount: 0,
    activeBy: [],
  };
  if (missing || raw.bare) return facts;
  const st = await runGit(raw.path, ["status", "--porcelain=v1", "--untracked-files=normal"], {
    timeoutMs: 20_000,
  });
  if (st.ok) {
    const ls = lines(st.stdout);
    facts.dirtyCount = ls.length;
    facts.dirty = ls.length > 0;
    if (ls.length) facts.dirtySample = ls.slice(0, 6);
    facts.untrackedCount = ls.filter((l) => l.startsWith("??")).length;
  } else {
    // Could not prove it is clean → treat as dirty.
    facts.dirty = true;
    facts.dirtyCount = -1;
  }
  try {
    const gd = await runGit(raw.path, ["rev-parse", "--absolute-git-dir"]);
    const idx = path.join(gd.stdout.trim(), "index");
    facts.lastActivityAt = fs.statSync(idx).mtimeMs;
  } catch {
    /* no index yet */
  }
  if (opts.sizes) {
    const hit = sizeCache.get(raw.path);
    if (hit && Date.now() - hit.at < SIZE_TTL_MS) facts.sizeBytes = hit.bytes;
    else {
      facts.sizeBytes = await duBytes(raw.path);
      sizeCache.set(raw.path, { at: Date.now(), bytes: facts.sizeBytes });
    }
  }
  return facts;
}

// ── Branches ─────────────────────────────────────────────────────────

interface RawRef {
  ref: string;
  name: string;
  shortName: string;
  kind: "local" | "remote";
  remote?: string;
  sha: string;
  at: number;
  author?: string;
  subject?: string;
  upstream?: string;
  upstreamGone?: boolean;
  ahead?: number;
  behind?: number;
}

async function listRefs(root: string, base?: string): Promise<RawRef[]> {
  const fmt = [
    "%(refname)",
    "%(objectname)",
    "%(committerdate:unix)",
    "%(authorname)",
    "%(subject)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(symref)",
    base ? `%(ahead-behind:${base})` : "",
  ].join(SEP);
  const res = await runGit(
    root,
    ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes"],
    {
      timeoutMs: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (!res.ok) return [];
  const out: RawRef[] = [];
  for (const l of lines(res.stdout)) {
    const [ref, sha, ct, author, subject, upstream, track, symref, ab] = l.split(SEP);
    if (symref) continue; // origin/HEAD
    const local = ref.startsWith("refs/heads/");
    const name = local ? ref.slice(11) : ref.slice(13);
    const remote = local ? undefined : name.split("/")[0];
    const shortName = local ? name : name.slice((remote?.length ?? 0) + 1);
    const [ahead, behind] = (ab ?? "").trim().split(/\s+/).map(Number);
    out.push({
      ref,
      name,
      shortName,
      kind: local ? "local" : "remote",
      remote,
      sha,
      at: Number(ct) * 1000,
      author: author || undefined,
      subject: subject || undefined,
      upstream: upstream || undefined,
      upstreamGone: track === "[gone]",
      ahead: Number.isFinite(ahead) ? ahead : undefined,
      behind: Number.isFinite(behind) ? behind : undefined,
    });
  }
  return out;
}

async function mergedSet(root: string, base: string): Promise<Set<string>> {
  const res = await runGit(
    root,
    ["for-each-ref", "--format=%(refname)", `--merged=${base}`, "refs/heads", "refs/remotes"],
    { timeoutMs: 20_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return new Set(res.ok ? lines(res.stdout) : []);
}

/** patch-ids of the last `max` non-merge commits on the base branch. */
async function basePatchIds(root: string, base: string, max = 400): Promise<Set<string>> {
  const res = await gitPipe(
    root,
    ["log", "--no-merges", "-p", "--no-color", "--no-ext-diff", `--max-count=${max}`, base],
    ["patch-id", "--stable"],
    60_000,
  );
  const ids = new Set<string>();
  for (const l of lines(res.stdout)) ids.add(l.split(" ")[0]);
  return ids;
}

const mergeCache = new Map<string, { mergedBy: MergedBy | null | undefined; unique?: number }>();

/** Merge facts for one non-ancestor branch tip against the base. */
async function mergeFacts(
  root: string,
  base: string,
  baseSha: string,
  sha: string,
  ids: () => Promise<Set<string>>,
): Promise<{ mergedBy: MergedBy | null | undefined; unique?: number }> {
  const key = `${root}\0${baseSha}\0${sha}`;
  const hit = mergeCache.get(key);
  if (hit) return hit;
  let result: { mergedBy: MergedBy | null | undefined; unique?: number } = { mergedBy: undefined };
  const cherry = await runGit(root, ["cherry", base, sha], {
    timeoutMs: 20_000,
    maxBuffer: 8 << 20,
  });
  if (cherry.ok) {
    const ls = lines(cherry.stdout);
    const unique = ls.filter((l) => l.startsWith("+")).length;
    if (unique === 0) result = { mergedBy: "cherry", unique: 0 };
    else {
      result = { mergedBy: null, unique };
      const mb = await runGit(root, ["merge-base", base, sha]);
      const mbSha = mb.stdout.trim();
      if (mb.ok && mbSha) {
        const names = await runGit(root, ["diff", "--name-only", "--no-renames", mbSha, sha], {
          timeoutMs: 15_000,
          maxBuffer: 8 << 20,
        });
        const files = names.ok ? lines(names.stdout) : [];
        if (names.ok && files.length === 0) result = { mergedBy: "empty", unique: 0 };
        else if (files.length > 0 && files.length <= 1500) {
          const same = await runGit(
            root,
            ["diff", "--quiet", "--no-renames", base, sha, "--", ...files],
            {
              timeoutMs: 15_000,
            },
          );
          // exit 0 = identical content for every touched file.
          if (same.ok) result = { mergedBy: "content", unique: 0 };
        }
        if (result.mergedBy === null) {
          const pid = await gitPipe(
            root,
            ["diff", "--no-color", "--no-ext-diff", mbSha, sha],
            ["patch-id", "--stable"],
            20_000,
          );
          const id = pid.stdout.trim().split(" ")[0];
          if (id && (await ids()).has(id)) result = { mergedBy: "squash", unique: 0 };
        }
      }
    }
  }
  mergeCache.set(key, result);
  if (mergeCache.size > 20_000) mergeCache.delete(mergeCache.keys().next().value as string);
  return result;
}

// ── Stashes ──────────────────────────────────────────────────────────

async function listStashes(root: string, base?: string): Promise<StashRow[]> {
  const res = await runGit(root, ["stash", "list", `--format=%H${SEP}%gd${SEP}%ct${SEP}%gs`], {
    timeoutMs: 10_000,
  });
  if (!res.ok) return [];
  const rows = lines(res.stdout).map((l) => {
    const [sha, ref, ct, msg] = l.split(SEP);
    const m = (msg ?? "").match(/^(?:WIP on|On) ([^:]+):/);
    return {
      sha,
      ref,
      at: Number(ct) * 1000,
      message: msg ?? "",
      branch: m?.[1],
      files: 0,
    } as StashRow;
  });
  await mapLimit(rows, 4, async (s) => {
    const names = await runGit(root, [
      "stash",
      "show",
      "--include-untracked",
      "--name-only",
      s.sha,
    ]);
    let files = names.ok ? lines(names.stdout) : [];
    if (!names.ok) {
      const plain = await runGit(root, ["stash", "show", "--name-only", s.sha]);
      files = plain.ok ? lines(plain.stdout) : [];
    }
    s.files = files.length;
    if (base && files.length && files.length <= 1500) {
      const same = await runGit(root, ["diff", "--quiet", base, s.sha, "--", ...files]);
      s.inDeploy = same.ok;
    }
  });
  return rows;
}

// ── GitHub ───────────────────────────────────────────────────────────

function ghPrs(
  root: string,
  slug: string | undefined,
): Promise<{
  available: boolean;
  authed: boolean;
  prs: PullRequestInfo[];
  byHead: Map<string, PullRequestInfo>;
  error?: string;
}> {
  return new Promise((resolve) => {
    const empty = { prs: [], byHead: new Map<string, PullRequestInfo>() };
    if (!slug)
      return resolve({ available: false, authed: false, ...empty, error: "no GitHub remote" });
    execFile(
      "gh",
      [
        "pr",
        "list",
        "-R",
        slug,
        "--state",
        "all",
        "--limit",
        "500",
        "--json",
        "number,headRefName,baseRefName,state,mergedAt,url,title",
      ],
      {
        cwd: root,
        timeout: 20_000,
        maxBuffer: 16 << 20,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
          return resolve({
            available: !missing,
            authed: false,
            ...empty,
            error: missing
              ? "gh not installed"
              : String(stderr || err.message)
                  .trim()
                  .slice(0, 200),
          });
        }
        try {
          const list = JSON.parse(String(stdout)) as Array<
            PullRequestInfo & { headRefName: string }
          >;
          const rank = { MERGED: 3, OPEN: 2, CLOSED: 1 } as const;
          const byHead = new Map<string, PullRequestInfo>();
          for (const pr of list) {
            const cur = byHead.get(pr.headRefName);
            if (!cur || rank[pr.state] > rank[cur.state]) byHead.set(pr.headRefName, pr);
          }
          resolve({ available: true, authed: true, prs: list, byHead });
        } catch (e) {
          resolve({ available: true, authed: true, ...empty, error: String(e) });
        }
      },
    );
  });
}

// ── Scan ─────────────────────────────────────────────────────────────

export async function defaultBranchOf(root: string): Promise<string | undefined> {
  const sym = await runGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim().replace(/^origin\//, "");
  for (const cand of ["main", "master"]) {
    const r = await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${cand}`]);
    if (r.ok) return cand;
  }
  return undefined;
}

/** refs/heads/<b> if it exists locally, else refs/remotes/origin/<b>. */
export async function resolveBranchRef(
  root: string,
  branch: string,
): Promise<{ ref: string; sha: string } | null> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const r = await runGit(root, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.ok && r.stdout.trim()) return { ref, sha: r.stdout.trim() };
  }
  return null;
}

export function emptyTotals(): HealthTotals {
  return {
    safe: 0,
    review: 0,
    active: 0,
    protected: 0,
    remoteSafe: 0,
    remoteReview: 0,
    worktreesSafe: 0,
    worktreesReview: 0,
    uniqueWork: 0,
    stashes: 0,
    worktrees: 0,
    branches: 0,
    remoteBranches: 0,
    reclaimBytes: 0,
  };
}

export async function scanRepoHealth(
  rootIn: string,
  opts: ScanOptions = {},
): Promise<HealthReport> {
  const started = Date.now();
  const now = opts.now ?? started;
  const warnings: string[] = [];
  const top = await runGit(rootIn, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`${rootIn} is not a git repository`);
  const worktreeRaw = await listWorktrees(top.stdout.trim());
  // Run repo-wide commands from the main worktree.
  const root =
    worktreeRaw[0]?.path && fs.existsSync(worktreeRaw[0].path)
      ? worktreeRaw[0].path
      : top.stdout.trim();
  const remoteUrl = (await runGit(root, ["remote", "get-url", "origin"])).stdout.trim();
  const slug = remoteSlug(remoteUrl || undefined);
  const defaultBranch = await defaultBranchOf(root);

  const deployBranch = opts.deployBranch?.trim() || undefined;
  let baseBranch = deployBranch;
  let comparedAgainst: HealthReport["comparedAgainst"] = deployBranch ? "deploy" : "default";
  let base = baseBranch ? await resolveBranchRef(root, baseBranch) : null;
  if (deployBranch && !base) warnings.push(`deploy branch "${deployBranch}" was not found`);
  if (!base && defaultBranch) {
    baseBranch = defaultBranch;
    comparedAgainst = "default";
    base = await resolveBranchRef(root, defaultBranch);
  }
  if (!base) comparedAgainst = "none";

  opts.onProgress?.("worktrees", 0, worktreeRaw.length);
  // When the deploy branch is local and origin's copy is ahead, work merged
  // on GitHub is "in the deploy branch" there but not in the deploy folder.
  let originBase: { ref: string; sha: string } | null = null;
  if (base?.ref.startsWith("refs/heads/") && baseBranch) {
    const o = await runGit(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${baseBranch}`,
    ]);
    const oSha = o.stdout.trim();
    if (o.ok && oSha && oSha !== base.sha) {
      const ahead = await runGit(root, ["rev-list", "--count", `${base.ref}..${oSha}`]);
      const n = Number(ahead.stdout.trim());
      if (n > 0) {
        originBase = { ref: `refs/remotes/origin/${baseBranch}`, sha: oSha };
        warnings.push(
          `the local ${baseBranch} is ${n} commit${n === 1 ? "" : "s"} behind origin/${baseBranch} — pull it in the deploy folder before deploying`,
        );
      }
    }
  }
  const [refs, merged, mergedOrigin, users, gh, stashes] = await Promise.all([
    listRefs(root, base?.ref),
    base ? mergedSet(root, base.ref) : Promise.resolve(new Set<string>()),
    originBase ? mergedSet(root, originBase.ref) : Promise.resolve(new Set<string>()),
    collectFolderUsers(),
    opts.github === false ? Promise.resolve(null) : ghPrs(root, slug),
    listStashes(root, base?.ref),
  ]);
  let wtDone = 0;
  const worktrees = await mapLimit(worktreeRaw, opts.sizes ? 3 : 6, async (w, i) => {
    const f = await worktreeFacts(w, i, { sizes: opts.sizes === true });
    opts.onProgress?.("worktrees", ++wtDone, worktreeRaw.length);
    return f;
  });
  const usersByPath = attributeUsers(
    worktrees.map((w) => w.path),
    users,
  );
  for (const w of worktrees) w.activeBy = usersByPath.get(w.path) ?? [];
  const wtByPath = new Map(worktrees.map((w) => [w.path, w]));
  const deployWorktreePath = opts.deployWorktreePath
    ? path.resolve(opts.deployWorktreePath)
    : undefined;
  if (deployWorktreePath && !wtByPath.has(deployWorktreePath)) {
    warnings.push(`deploy folder ${deployWorktreePath} is not a worktree of this repo`);
  }
  const deployWorktreeBranch = deployWorktreePath
    ? wtByPath.get(deployWorktreePath)?.branch
    : undefined;
  if (deployBranch && deployWorktreeBranch && deployWorktreeBranch !== deployBranch) {
    warnings.push(
      `deploy folder is on "${deployWorktreeBranch}", not the deploy branch "${deployBranch}"`,
    );
  }

  let idsPromise: Promise<Set<string>> | null = null;
  const ids = () =>
    (idsPromise ??= base ? basePatchIds(root, base.ref) : Promise.resolve(new Set<string>()));

  opts.onProgress?.("branches", 0, refs.length);
  let brDone = 0;
  const facts = await mapLimit(refs, 8, async (r): Promise<BranchFacts> => {
    const worktreePaths =
      r.kind === "local"
        ? worktrees.filter((w) => w.branch === r.shortName).map((w) => w.path)
        : [];
    const f: BranchFacts = {
      name: r.name,
      shortName: r.shortName,
      kind: r.kind,
      remote: r.remote,
      sha: r.sha,
      lastCommitAt: r.at,
      author: r.author,
      subject: r.subject,
      upstream: r.upstream,
      upstreamGone: r.upstreamGone,
      ahead: r.ahead,
      behind: r.behind,
      worktreePaths,
      isDeployBranch: Boolean(deployBranch && r.shortName === deployBranch),
      isDefaultBranch: Boolean(defaultBranch && r.shortName === defaultBranch),
      isProtectedRemote:
        r.kind === "remote" &&
        Boolean(
          (deployBranch && r.shortName === deployBranch) ||
          (defaultBranch && r.shortName === defaultBranch),
        ),
    };
    if (gh?.byHead.has(r.shortName)) f.pr = gh.byHead.get(r.shortName);
    if (!base) f.mergedBy = undefined;
    else if (merged.has(r.ref) || r.sha === base.sha) {
      f.mergedBy = "ancestor";
      f.uniqueCommits = 0;
    } else {
      const m = await mergeFacts(root, base.ref, base.sha, r.sha, ids);
      f.mergedBy = m.mergedBy;
      f.uniqueCommits = m.unique;
      if (m.mergedBy === null && mergedOrigin.has(r.ref)) f.inOriginDeploy = true;
    }
    opts.onProgress?.("branches", ++brDone, refs.length);
    return f;
  });

  const mainBranch = worktrees[0]?.branch;
  const ctx = {
    deployBranch,
    defaultBranch,
    mainBranch,
    deployWorktreeBranch,
    now,
    worktreesByPath: wtByPath,
  };
  const branches: BranchRow[] = facts.map((f) => ({ ...f, ...classifyBranch(f, ctx) }));
  const branchByName = new Map(
    branches.filter((b) => b.kind === "local").map((b) => [b.shortName, b]),
  );

  // Detached worktrees: classify their HEAD like a branch tip.
  const wtRows: WorktreeRow[] = await mapLimit(worktrees, 6, async (w) => {
    let branchRow: { classification: Classification; facts?: BranchFacts } | null = null;
    const b = w.branch ? branchByName.get(w.branch) : undefined;
    if (b) branchRow = { classification: b, facts: b };
    else if (w.head && base) {
      const anc = await runGit(root, ["merge-base", "--is-ancestor", w.head, base.ref]);
      const m = anc.ok
        ? { mergedBy: "ancestor" as MergedBy, unique: 0 }
        : await mergeFacts(root, base.ref, base.sha, w.head, ids);
      const pseudo: BranchFacts = {
        name: `(detached ${w.head.slice(0, 8)})`,
        shortName: `(detached ${w.head.slice(0, 8)})`,
        kind: "local",
        sha: w.head,
        lastCommitAt:
          Number((await runGit(root, ["log", "-1", "--format=%ct", w.head])).stdout.trim()) *
            1000 || 0,
        mergedBy: m.mergedBy,
        uniqueCommits: m.unique,
        worktreePaths: [w.path],
      };
      branchRow = { classification: classifyBranch(pseudo, ctx), facts: pseudo };
    }
    return { ...w, ...classifyWorktree(w, branchRow, { deployWorktreePath }) };
  });

  const totals = emptyTotals();
  for (const b of branches) {
    if (b.kind === "local") {
      totals.branches++;
      totals[b.group]++;
      if (b.uniqueWork) totals.uniqueWork++;
      if (b.inOriginDeploy) totals.notPulled = (totals.notPulled ?? 0) + 1;
    } else {
      totals.remoteBranches++;
      if (b.group === "safe") totals.remoteSafe++;
      else if (b.group === "review") totals.remoteReview++;
    }
  }
  for (const w of wtRows) {
    if (w.group === "safe" && !w.main) totals.worktreesSafe++;
    else if (w.group === "review") totals.worktreesReview++;
  }
  totals.worktrees = wtRows.length;
  totals.stashes = stashes.length;
  totals.reclaimBytes = wtRows
    .filter((w) => w.group === "safe" && !w.main)
    .reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
  if (gh?.error && gh.available) {
    warnings.push(
      /auth login|GH_TOKEN|not logged/i.test(gh.error)
        ? "GitHub not connected — run `gh auth login` to see merged PRs"
        : `GitHub: ${gh.error}`,
    );
  }

  return {
    name: path.basename(root),
    root,
    scannedAt: now,
    durationMs: Date.now() - started,
    deployBranch,
    baseRef: base?.ref,
    baseSha: base?.sha,
    comparedAgainst,
    defaultBranch,
    remoteSlug: slug,
    gh: gh
      ? { available: gh.available, authed: gh.authed, prs: gh.prs.length, error: gh.error }
      : { available: false, authed: false, prs: 0, error: "skipped" },
    branches,
    worktrees: wtRows,
    stashes,
    totals,
    warnings,
  };
}

/** Drop cached merge facts (tests). */
export function clearBranchHealthCaches(): void {
  mergeCache.clear();
  sizeCache.clear();
}

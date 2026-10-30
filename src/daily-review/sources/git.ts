/**
 * Git activity across the owner's repos. Repos and worktrees are discovered
 * under the configured roots and deduplicated by their *common* git dir, so a
 * repo with forty worktrees is logged once (`--all` covers every branch) and
 * each commit is counted once.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { projectFromPath } from "../classify.js";
import { clean } from "../util.js";

const execFileAsync = promisify(execFile);

export interface RepoRef {
  name: string;
  gitDir: string;
  workTree: string;
}

export interface CommitRecord {
  repo: string;
  project: string;
  sha: string;
  ts: number;
  subject: string;
  merge: boolean;
}

/** Resolve the common git dir for a checkout (handles worktree `.git` files). */
export function commonGitDir(dir: string): string | null {
  const dotGit = path.join(dir, ".git");
  let st: fs.Stats;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return fs.realpathSync(dotGit);
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const wtGit = path.resolve(dir, m[1]!.trim());
    const commonFile = path.join(wtGit, "commondir");
    if (fs.existsSync(commonFile)) {
      return fs.realpathSync(path.resolve(wtGit, fs.readFileSync(commonFile, "utf8").trim()));
    }
    return fs.realpathSync(wtGit);
  } catch {
    return null;
  }
}

export function discoverRepos(
  roots: string[],
  extra: string[] = [],
  exclude: string[] = [],
): RepoRef[] {
  const candidates = new Set<string>();
  for (const root of roots) {
    candidates.add(root);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) candidates.add(path.join(root, e.name));
    }
  }
  for (const x of extra) candidates.add(x);
  const byCommon = new Map<string, RepoRef>();
  for (const dir of candidates) {
    if (exclude.some((x) => dir === x || dir.startsWith(`${x}/`))) continue;
    const common = commonGitDir(dir);
    if (!common || byCommon.has(common)) continue;
    // Name after the main checkout (parent of the common .git dir).
    const main =
      path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "");
    byCommon.set(common, { name: path.basename(main), gitDir: common, workTree: main });
  }
  return [...byCommon.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SEP = "\x1f";

export async function repoCommits(
  repo: RepoRef,
  fromMs: number,
  toMs: number,
): Promise<CommitRecord[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        `--git-dir=${repo.gitDir}`,
        "log",
        "--exclude=refs/stash",
        "--all",
        `--since=@${Math.floor(fromMs / 1000)}`,
        `--until=@${Math.floor(toMs / 1000)}`,
        `--format=%H${SEP}%ct${SEP}%P${SEP}%s`,
      ],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const project = projectFromPath(repo.workTree) ?? repo.name;
    const out: CommitRecord[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [sha, ct, parents, subject] = line.split(SEP);
      const ts = Number(ct) * 1000;
      if (!sha || !Number.isFinite(ts) || ts < fromMs || ts >= toMs) continue;
      out.push({
        repo: repo.name,
        project,
        sha: sha.slice(0, 10),
        ts,
        subject: clean(subject, 120),
        merge: (parents ?? "").trim().split(/\s+/).length > 1,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadCommits(
  repos: RepoRef[],
  fromMs: number,
  toMs: number,
): Promise<CommitRecord[]> {
  const seen = new Set<string>();
  const all: CommitRecord[] = [];
  // A few at a time: git log on big repos is IO-heavy.
  for (let i = 0; i < repos.length; i += 4) {
    const batch = await Promise.all(repos.slice(i, i + 4).map((r) => repoCommits(r, fromMs, toMs)));
    for (const list of batch) {
      for (const c of list) {
        if (seen.has(c.sha)) continue;
        seen.add(c.sha);
        all.push(c);
      }
    }
  }
  return all;
}

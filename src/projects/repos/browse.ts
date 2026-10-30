/**
 * Project repos — folder browsing + repo suggestions for the picker.
 *
 * browseDirectories(): one level of sub-directories with a cheap `.git`
 * check; detected repos get a git status card (branch, remote, last commit).
 * listRepoSuggestions(): recently picked repos (a tiny JSON under the state
 * dir) plus git checkouts / coder worktrees under ~/Desktop/Development.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasGitDir, inspectRepo, normalizeRepoPath, type RepoInfo } from "./git-info.js";

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
  hidden: boolean;
  repo?: RepoInfo;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  /** The browsed folder itself is a repo checkout root. */
  isRepo: boolean;
  repo?: RepoInfo;
  entries: BrowseEntry[];
  truncated: boolean;
  roots: Array<{ label: string; path: string }>;
}

const MAX_ENTRIES = 400;
const MAX_INSPECT = 48;

export function developmentRoot(): string {
  const env = process.env.INFINIBOT_DEV_ROOT?.trim();
  return env ? normalizeRepoPath(env) : path.join(os.homedir(), "Desktop", "Development");
}

export function browseRoots(): Array<{ label: string; path: string }> {
  const home = os.homedir();
  const out: Array<{ label: string; path: string }> = [{ label: "Home", path: home }];
  for (const [label, p] of [
    ["Development", developmentRoot()],
    ["Desktop", path.join(home, "Desktop")],
    ["Projects", path.join(home, "projects")],
    ["Code", path.join(home, "code")],
  ] as const) {
    try {
      if (fs.statSync(p).isDirectory()) out.push({ label, path: p });
    } catch {
      /* missing */
    }
  }
  return out;
}

export async function browseDirectories(params: {
  path?: string;
  showHidden?: boolean;
  inspect?: boolean;
}): Promise<BrowseResult> {
  const dir = normalizeRepoPath(params.path || developmentRoot()) || os.homedir();
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);
  const dirents = fs.readdirSync(dir, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    if (d.name === "node_modules" || d.name === ".git") continue;
    const hidden = d.name.startsWith(".");
    if (hidden && !params.showHidden) continue;
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({ name: d.name, path: full, isRepo: hasGitDir(full), hidden });
  }
  // Repos first, then alphabetical.
  entries.sort((a, b) =>
    a.isRepo === b.isRepo ? a.name.localeCompare(b.name) : a.isRepo ? -1 : 1,
  );
  const truncated = entries.length > MAX_ENTRIES;
  const shown = entries.slice(0, MAX_ENTRIES);
  if (params.inspect !== false) {
    const repos = shown.filter((e) => e.isRepo).slice(0, MAX_INSPECT);
    await Promise.all(
      repos.map(async (e) => {
        e.repo = await inspectRepo(e.path);
      }),
    );
  }
  const isRepo = hasGitDir(dir);
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    isRepo,
    repo: isRepo ? await inspectRepo(dir) : undefined,
    entries: shown,
    truncated,
    roots: browseRoots(),
  };
}

// ── Recents ────────────────────────────────────────────────────────────

const MAX_RECENTS = 20;

function recentsFile(stateDir: string): string {
  return path.join(stateDir, "projects", "repo-recents.json");
}

export function readRecentRepos(stateDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(recentsFile(stateDir), "utf8"));
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecentRepo(stateDir: string, repoPath: string): void {
  const p = normalizeRepoPath(repoPath);
  if (!p) return;
  const next = [p, ...readRecentRepos(stateDir).filter((x) => x !== p)].slice(0, MAX_RECENTS);
  try {
    fs.mkdirSync(path.dirname(recentsFile(stateDir)), { recursive: true });
    fs.writeFileSync(recentsFile(stateDir), JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
}

// ── Suggestions ────────────────────────────────────────────────────────

export interface RepoSuggestions {
  recent: RepoInfo[];
  development: RepoInfo[];
  root: string;
}

/** Git checkouts directly under the development root, newest first. */
export function scanDevelopmentRepos(limit = 60): string[] {
  const root = developmentRoot();
  let dirents: fs.Dirent[] = [];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Array<{ p: string; mtime: number }> = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name === "node_modules") continue;
    const full = path.join(root, d.name);
    if (!hasGitDir(full)) continue;
    let mtime = 0;
    try {
      // .git/index (or the worktree's .git file) moves on every commit/checkout.
      const gitPath = path.join(full, ".git");
      const g = fs.statSync(gitPath);
      mtime = g.isDirectory()
        ? (fs.statSync(path.join(gitPath, "index"), { throwIfNoEntry: false })?.mtimeMs ??
          g.mtimeMs)
        : fs.statSync(full).mtimeMs;
    } catch {
      /* ignore */
    }
    found.push({ p: full, mtime });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((f) => f.p);
}

export async function listRepoSuggestions(
  stateDir: string,
  opts: { limit?: number } = {},
): Promise<RepoSuggestions> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 120);
  const recentPaths = readRecentRepos(stateDir);
  const devPaths = scanDevelopmentRepos(limit).filter((p) => !recentPaths.includes(p));
  const [recent, development] = await Promise.all([
    Promise.all(recentPaths.map((p) => inspectRepo(p))),
    Promise.all(devPaths.map((p) => inspectRepo(p))),
  ]);
  return {
    recent: recent.filter((r) => r.isRepo),
    development: development.filter((r) => r.isRepo),
    root: developmentRoot(),
  };
}

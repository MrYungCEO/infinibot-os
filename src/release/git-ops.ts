/**
 * Thin git / npm helpers for the release-publisher daemon. Every shell-out goes
 * through `runCommandWithTimeout` so it inherits timeout + abort handling.
 */

import fs from "node:fs";
import path from "node:path";

import { runCommandWithTimeout } from "../process/exec.js";

export interface ExecOpts {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function run(
  argv: string[],
  opts: ExecOpts,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  if (opts.signal?.aborted) {
    return { ok: false, stdout: "", stderr: "aborted", code: null };
  }
  const res = await runCommandWithTimeout(argv, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  return {
    ok: res.code === 0 && !res.killed,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.code,
  };
}

/** Detect the package manager: explicit override, else pnpm lockfile, else npm. */
export function detectPackageManager(
  repoDir: string,
  override: "auto" | "pnpm" | "npm" = "auto",
): "pnpm" | "npm" {
  if (override !== "auto") return override;
  if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

export async function currentBranch(repoDir: string, signal?: AbortSignal): Promise<string | null> {
  const res = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, signal });
  if (!res.ok) return null;
  const b = res.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}

export async function headSha(repoDir: string, signal?: AbortSignal): Promise<string | null> {
  const res = await run(["git", "rev-parse", "HEAD"], { cwd: repoDir, signal });
  return res.ok ? res.stdout.trim() : null;
}

/** Porcelain status entry: path + whether it's tracked-and-modified vs untracked. */
export interface ChangedFile {
  path: string;
  untracked: boolean;
}

/**
 * Parse `git status --porcelain=v1 -z`. Returns one entry per changed path
 * (renames surface as the destination path). Deleted files are included so they
 * can be staged with `git add -A <bucket>`.
 */
export async function changedFiles(repoDir: string, signal?: AbortSignal): Promise<ChangedFile[]> {
  const res = await run(["git", "status", "--porcelain=v1", "-z"], { cwd: repoDir, signal });
  if (!res.ok) return [];
  const out: ChangedFile[] = [];
  const records = res.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const x = rec[0];
    const y = rec[1];
    let p = rec.slice(3);
    // Renames/copies emit "R old -> new" as two NUL fields; the second field is
    // the old path which we skip.
    if (x === "R" || x === "C") {
      i++; // consume the paired old-path record
    }
    const untracked = x === "?" && y === "?";
    out.push({ path: p, untracked });
  }
  return out;
}

export async function isTreeClean(repoDir: string, signal?: AbortSignal): Promise<boolean> {
  return (await changedFiles(repoDir, signal)).length === 0;
}

// ── Scope bucketing ──────────────────────────────────────────────────

export interface ScopeRule {
  scope: string;
  prefix: "feat" | "fix" | "chore" | "docs";
  /** First-match-wins predicate against a repo-relative path. */
  test: (p: string) => boolean;
}

/** Ordered scope rules — first match wins per file. */
export const SCOPE_RULES: ScopeRule[] = [
  { scope: "docs", prefix: "docs", test: (p) => p.startsWith("docs/") },
  { scope: "mobile", prefix: "feat", test: (p) => p.startsWith("mobile/") },
  { scope: "ui", prefix: "feat", test: (p) => p.startsWith("ui/") },
  { scope: "gateway", prefix: "feat", test: (p) => p.startsWith("src/gateway/") },
  { scope: "core", prefix: "feat", test: (p) => p.startsWith("src/") },
  { scope: "chore", prefix: "chore", test: () => true },
];

export interface ScopeBucket {
  scope: string;
  prefix: string;
  files: string[];
}

/** Group changed files into ordered scope buckets (empty buckets dropped). */
export function bucketByScope(files: string[]): ScopeBucket[] {
  const buckets = new Map<string, ScopeBucket>();
  for (const f of files) {
    const rule = SCOPE_RULES.find((r) => r.test(f))!;
    let b = buckets.get(rule.scope);
    if (!b) {
      b = { scope: rule.scope, prefix: rule.prefix, files: [] };
      buckets.set(rule.scope, b);
    }
    b.files.push(f);
  }
  // Preserve SCOPE_RULES ordering.
  return SCOPE_RULES.map((r) => buckets.get(r.scope)).filter((b): b is ScopeBucket => !!b);
}

const COAUTHOR_LINE = "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>";

/** Build a conventional-commit message for a bucket. */
export function commitMessageFor(bucket: ScopeBucket): string {
  const header =
    bucket.scope === "docs"
      ? `docs: update ${bucket.files.length} doc file(s)`
      : bucket.scope === "chore"
        ? `chore: update ${bucket.files.length} file(s)`
        : `${bucket.prefix}(${bucket.scope}): publish ${bucket.files.length} change(s)`;
  const body = bucket.files
    .slice(0, 20)
    .map((f) => `- ${f}`)
    .join("\n");
  const more = bucket.files.length > 20 ? `\n- …and ${bucket.files.length - 20} more` : "";
  return `${header}\n\nAuto-published by release-publisher daemon.\n\n${body}${more}\n\n${COAUTHOR_LINE}`;
}

// ── Build / pack ─────────────────────────────────────────────────────

export interface BuildResult {
  ok: boolean;
  stderr: string;
  durationMs: number;
}

export async function runBuild(
  repoDir: string,
  pm: "pnpm" | "npm",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const start = Date.now();
  const res = await run([pm, "run", "build"], { cwd: repoDir, timeoutMs, signal });
  return {
    ok: res.ok,
    stderr: res.ok ? "" : res.stderr || res.stdout,
    durationMs: Date.now() - start,
  };
}

export interface PackDrift {
  ok: boolean;
  /** src/ subdirs whose compiled dist/ output is NOT in the pack file list. */
  missing: string[];
}

/**
 * Verify the npm `files[]` whitelist still covers every top-level `src/`
 * subdir. The build compiles `src/<x>/**` → `dist/<x>/**`, and `files[]`
 * whitelists `dist/<x>/**`; a new src subdir added without its dist entry is
 * silently dropped from the published tarball. We compare the set of top-level
 * src subdirs against the dist subdirs present in `npm pack --dry-run --json`.
 */
export async function checkPackDrift(repoDir: string, signal?: AbortSignal): Promise<PackDrift> {
  const srcDir = path.join(repoDir, "src");
  let srcSubdirs: string[] = [];
  try {
    srcSubdirs = fs
      .readdirSync(srcDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { ok: true, missing: [] };
  }

  const res = await run(["npm", "pack", "--dry-run", "--json"], {
    cwd: repoDir,
    timeoutMs: 120_000,
    signal,
  });
  if (!res.ok) {
    // Can't determine drift — fail open (don't block on a flaky pack), but
    // report it as not-ok so the caller can log.
    return { ok: false, missing: [] };
  }

  let packedDistDirs = new Set<string>();
  try {
    const parsed = JSON.parse(res.stdout) as Array<{ files?: Array<{ path: string }> }>;
    for (const entry of parsed) {
      for (const f of entry.files ?? []) {
        const m = /^dist\/([^/]+)\//.exec(f.path);
        if (m) packedDistDirs.add(m[1]);
      }
    }
  } catch {
    return { ok: false, missing: [] };
  }

  const missing = srcSubdirs.filter((d) => !packedDistDirs.has(d));
  return { ok: missing.length === 0, missing };
}

// ── Commit / push / PR comment ───────────────────────────────────────

export async function stageAndCommit(
  repoDir: string,
  files: string[],
  message: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  // Stage exactly this bucket's paths (-A picks up deletions too).
  const add = await run(["git", "add", "-A", "--", ...files], { cwd: repoDir, signal });
  if (!add.ok) return { ok: false, error: `git add failed: ${add.stderr}` };
  const commit = await run(["git", "commit", "-m", message], { cwd: repoDir, signal });
  if (!commit.ok)
    return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  return { ok: true };
}

export async function push(
  repoDir: string,
  remote: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const res = await run(["git", "push", remote, `HEAD:${branch}`], {
    cwd: repoDir,
    timeoutMs: 120_000,
    signal,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.stderr || res.stdout };
}

export async function prComment(
  repoDir: string,
  prNumber: number,
  body: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const res = await run(["gh", "pr", "comment", String(prNumber), "-b", body], {
    cwd: repoDir,
    timeoutMs: 60_000,
    signal,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.stderr || res.stdout };
}

/**
 * Branch health — pure classification rules.
 *
 * Every branch / worktree of a repo lands in exactly one group:
 *
 *   protected  the deploy branch, main/master/default, the branch the main
 *              or deploy checkout sits on, release branches still in use
 *   active     used by a running agent/process, or committed to recently
 *   review     has unique work not in the deploy branch, a dirty worktree,
 *              or merge status could not be proven
 *   safe       fully merged into the deploy branch (ancestor, cherry-picked,
 *              squash-merged or identical content), clean, idle
 *
 * The same rules gate the cleanup executor (`cleanupBlockReason`), so the
 * dry-run preview and the real run can never disagree about what is safe.
 */

export type HealthGroup = "protected" | "active" | "review" | "safe";

/** How a branch's work was proven to be in the deploy branch. */
export type MergedBy = "ancestor" | "cherry" | "squash" | "content" | "empty";

export interface PullRequestInfo {
  number: number;
  state: "MERGED" | "OPEN" | "CLOSED";
  url?: string;
  title?: string;
  baseRefName?: string;
  mergedAt?: string;
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  head: string;
  main: boolean;
  detached: boolean;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
  /** Missing on disk (git still lists it). */
  missing?: boolean;
  dirty: boolean;
  dirtyCount: number;
  /** First few `git status --porcelain` lines (so the owner sees what is dirty). */
  dirtySample?: string[];
  /** Untracked (non-ignored) entries — `git worktree remove` refuses these. */
  untrackedCount?: number;
  sizeBytes?: number;
  /** Who is using it right now: "agent: label", "tmux: sess", "process: node". */
  activeBy: string[];
  /** Last HEAD movement or file change, unix ms. */
  lastActivityAt?: number;
}

export interface BranchFacts {
  /** Short name: "feat/x" (local) or "origin/feat/x" (remote). */
  name: string;
  /** Branch name without the remote prefix. */
  shortName: string;
  kind: "local" | "remote";
  remote?: string;
  sha: string;
  lastCommitAt: number;
  author?: string;
  subject?: string;
  upstream?: string;
  upstreamGone?: boolean;
  /** Commits on the deploy branch not on this branch. */
  behind?: number;
  /** Commits on this branch not on the deploy branch. */
  ahead?: number;
  /** null = not merged; undefined = could not be determined. */
  mergedBy?: MergedBy | null;
  /** Commits whose patch is not in the deploy branch (git cherry "+"). */
  uniqueCommits?: number;
  /**
   * Merged into origin's copy of the deploy branch while the local deploy
   * branch has not pulled it yet (the deploy folder is behind origin).
   */
  inOriginDeploy?: boolean;
  pr?: PullRequestInfo;
  /** Worktrees that have this branch checked out. */
  worktreePaths: string[];
  isDeployBranch?: boolean;
  isDefaultBranch?: boolean;
  /** Origin's copy of the deploy/default branch. */
  isProtectedRemote?: boolean;
}

export interface ClassifyContext {
  deployBranch?: string;
  defaultBranch?: string;
  /** Branch of the main worktree (cannot be deleted while checked out). */
  mainBranch?: string;
  /** Branch the deploy checkout sits on (may differ from deployBranch). */
  deployWorktreeBranch?: string;
  now: number;
  worktreesByPath: Map<string, WorktreeFacts>;
  /** Commits newer than this are "active" (default 3 days). */
  activeWindowMs?: number;
  /** Release branches with commits newer than this stay protected. */
  releaseWindowMs?: number;
}

export interface Classification {
  group: HealthGroup;
  reasons: string[];
  /** True when the branch holds work found nowhere in the deploy branch. */
  uniqueWork: boolean;
}

export const ACTIVE_WINDOW_MS = 3 * 86_400_000;
export const RELEASE_WINDOW_MS = 3 * 86_400_000;
const ALWAYS_PROTECTED = new Set(["main", "master", "trunk", "develop", "production", "prod"]);
const RELEASE_RE = /^(release|deploy|releases|hotfix)[/-]/i;

export function isReleaseName(name: string): boolean {
  return RELEASE_RE.test(name);
}

export function isMerged(b: Pick<BranchFacts, "mergedBy">): boolean {
  return b.mergedBy !== null && b.mergedBy !== undefined;
}

export function classifyBranch(b: BranchFacts, ctx: ClassifyContext): Classification {
  const reasons: string[] = [];
  const short = b.shortName;
  const wts = b.worktreePaths
    .map((p) => ctx.worktreesByPath.get(p))
    .filter((w): w is WorktreeFacts => Boolean(w));
  const uniqueWork =
    !isMerged(b) && !b.inOriginDeploy && (b.uniqueCommits === undefined || b.uniqueCommits > 0);

  // ── Protected ──
  if (b.isDeployBranch || (ctx.deployBranch && short === ctx.deployBranch)) {
    reasons.push("deploy branch");
  }
  if (b.isDefaultBranch || (ctx.defaultBranch && short === ctx.defaultBranch)) {
    reasons.push("default branch");
  } else if (ALWAYS_PROTECTED.has(short)) {
    reasons.push(`${short} branch`);
  }
  if (b.kind === "local" && ctx.mainBranch && short === ctx.mainBranch) {
    reasons.push("checked out in the main folder");
  }
  if (b.kind === "local" && ctx.deployWorktreeBranch && short === ctx.deployWorktreeBranch) {
    reasons.push("checked out in the deploy folder");
  }
  if (b.isProtectedRemote) reasons.push("origin copy of a protected branch");
  if (wts.some((w) => w.main)) reasons.push("checked out in the main worktree");
  if (
    isReleaseName(short) &&
    ctx.now - b.lastCommitAt < (ctx.releaseWindowMs ?? RELEASE_WINDOW_MS)
  ) {
    reasons.push("recent release branch");
  }
  if (reasons.length) return { group: "protected", reasons, uniqueWork };

  // ── Active ──
  const users = wts.flatMap((w) => w.activeBy);
  if (users.length) reasons.push(`in use: ${[...new Set(users)].slice(0, 3).join(", ")}`);
  const recent = ctx.now - b.lastCommitAt < (ctx.activeWindowMs ?? ACTIVE_WINDOW_MS);
  if (recent) reasons.push("committed in the last 3 days");
  if (b.pr?.state === "OPEN") reasons.push(`PR #${b.pr.number} open`);
  if (reasons.length && b.inOriginDeploy) {
    reasons.push(
      `merged into origin/${ctx.deployBranch ?? "deploy"} — not pulled into the deploy folder yet`,
    );
  }
  if (reasons.length) return { group: "active", reasons, uniqueWork };

  // ── Review ──
  const dirty = wts.filter((w) => w.dirty);
  if (dirty.length) {
    reasons.push(
      `uncommitted changes in ${dirty.length === 1 ? dirty[0].path : `${dirty.length} worktrees`}`,
    );
  }
  if (b.mergedBy === undefined) reasons.push("merge status unknown");
  else if (b.mergedBy === null) {
    if (b.inOriginDeploy) {
      reasons.push(
        `merged into origin/${ctx.deployBranch ?? "deploy"}, but the local deploy branch has not pulled it yet`,
      );
    }
    reasons.push(
      b.uniqueCommits !== undefined
        ? `${b.uniqueCommits} commit${b.uniqueCommits === 1 ? "" : "s"} not in the deploy branch`
        : "not merged into the deploy branch",
    );
    if (b.pr?.state === "MERGED" && b.pr.baseRefName && b.pr.baseRefName !== ctx.deployBranch) {
      reasons.push(`PR #${b.pr.number} merged into ${b.pr.baseRefName}, not the deploy branch`);
    }
  }
  if (wts.some((w) => w.locked)) reasons.push("worktree is locked");
  if (reasons.length) return { group: "review", reasons, uniqueWork };

  // ── Safe ──
  reasons.push(mergedReason(b.mergedBy as MergedBy));
  if (b.pr?.state === "MERGED") reasons.push(`PR #${b.pr.number} merged`);
  return { group: "safe", reasons, uniqueWork: false };
}

export function mergedReason(m: MergedBy): string {
  switch (m) {
    case "ancestor":
      return "merged into the deploy branch";
    case "cherry":
      return "every commit is in the deploy branch (cherry-picked / rebased)";
    case "squash":
      return "squash-merged into the deploy branch";
    case "content":
      return "its changes are already in the deploy branch";
    case "empty":
      return "no changes of its own";
  }
}

/**
 * A worktree's group: the main worktree and the deploy checkout are always
 * protected; otherwise it follows the branch it holds, but a dirty or busy
 * worktree is never "safe".
 */
export function classifyWorktree(
  w: WorktreeFacts,
  branch: { classification: Classification; facts?: BranchFacts } | null,
  ctx: { deployWorktreePath?: string },
): Classification {
  const reasons: string[] = [];
  if (w.main) reasons.push("main folder of the repo");
  if (ctx.deployWorktreePath && w.path === ctx.deployWorktreePath) reasons.push("deploy folder");
  if (w.bare) reasons.push("bare repository");
  if (reasons.length) return { group: "protected", reasons, uniqueWork: false };
  if (w.activeBy.length) {
    return {
      group: "active",
      reasons: [`in use: ${w.activeBy.slice(0, 3).join(", ")}`],
      uniqueWork: branch?.classification.uniqueWork ?? false,
    };
  }
  if (w.dirty) {
    return {
      group: "review",
      reasons: [`${w.dirtyCount} uncommitted change${w.dirtyCount === 1 ? "" : "s"}`],
      uniqueWork: true,
    };
  }
  if (w.locked) return { group: "review", reasons: ["worktree is locked"], uniqueWork: false };
  if (w.missing || w.prunable) {
    return { group: "safe", reasons: ["folder is gone (stale record)"], uniqueWork: false };
  }
  if (!branch) return { group: "review", reasons: ["unknown HEAD"], uniqueWork: true };
  return branch.classification;
}

// ── Cleanup safety ───────────────────────────────────────────────────

export interface CleanupCandidate {
  type: "worktree" | "branch" | "remote-branch";
  name: string;
  path?: string;
}

/**
 * Why an item may NOT be deleted (null = allowed). This is the single gate
 * the executor applies after re-reading fresh facts.
 */
export function cleanupBlockReason(
  item: CleanupCandidate,
  facts: {
    branch?: BranchFacts;
    branchClass?: Classification;
    worktree?: WorktreeFacts;
    worktreeClass?: Classification;
    /** Worktrees (other than ones being removed in the same run) holding the branch. */
    otherCheckouts?: string[];
  },
  ctx: { deployBranch?: string; deployWorktreePath?: string; allowRemote?: boolean },
): string | null {
  if (item.type === "remote-branch" && !ctx.allowRemote) {
    return "remote branches are only deleted when explicitly selected";
  }
  if (item.type === "worktree") {
    const w = facts.worktree;
    if (!w) return "worktree not found";
    if (w.main) return "never removes the main folder";
    if (ctx.deployWorktreePath && w.path === ctx.deployWorktreePath) return "deploy folder";
    if (w.dirty) return "worktree has uncommitted changes";
    if (w.untrackedCount) return "worktree has untracked files";
    if (w.activeBy.length) return `in use: ${w.activeBy[0]}`;
    if (w.locked) return "worktree is locked";
    if (!facts.worktreeClass || facts.worktreeClass.group !== "safe") {
      return facts.worktreeClass?.reasons[0] ?? "not classified safe";
    }
    return null;
  }
  const b = facts.branch;
  if (!b) return "branch not found";
  if (ctx.deployBranch && b.shortName === ctx.deployBranch) return "deploy branch";
  if (!isMerged(b)) return "has commits that are not in the deploy branch";
  if (facts.otherCheckouts?.length) return `checked out in ${facts.otherCheckouts[0]}`;
  if (!facts.branchClass || facts.branchClass.group !== "safe") {
    return facts.branchClass?.reasons[0] ?? "not classified safe";
  }
  return null;
}

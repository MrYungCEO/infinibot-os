/**
 * Repos › deploy branch + branch health — client types and RPC wrappers.
 * Shared by the deploy card, the Repos page (health dashboard, cleanup,
 * restore) and the first-time setup wizard.
 */

import { awaitGatewayClient, type GatewayBrowserClient } from "../gateway-client";

export type HealthGroup = "protected" | "active" | "review" | "safe";
export type MergedBy = "ancestor" | "cherry" | "squash" | "content" | "empty";
export type DeployTargetKind = "fly" | "netlify" | "vercel" | "gateway" | "docker" | "other";

export interface DeployTarget {
  kind: DeployTargetKind;
  name?: string;
}

export interface DeployConfig {
  branch: string;
  worktreePath: string;
  target?: DeployTarget;
  command?: string;
  notes?: string;
  source: "manual" | "auto";
  confidence?: number;
  confirmedAt?: number;
  updatedAt: number;
  deploys?: Array<{ at: number; sha?: string; note?: string }>;
}

export interface DeployStatus {
  branch: string;
  worktreePath: string;
  exists: boolean;
  checkedOutBranch?: string;
  onDeployBranch: boolean;
  headSha?: string;
  headSubject?: string;
  headAt?: number;
  dirty: boolean;
  dirtyCount: number;
  originRef?: string;
  ahead?: number;
  behind?: number;
  fetchedAt?: number;
  lastDeploy?: { at: number; source: "fly" | "gateway" | "manual"; detail?: string };
  checkedAt: number;
}

export interface DeploySignal {
  kind: string;
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

export interface HealthTotals {
  safe: number;
  review: number;
  active: number;
  protected: number;
  remoteSafe: number;
  remoteReview: number;
  worktreesSafe: number;
  worktreesReview: number;
  uniqueWork: number;
  notPulled?: number;
  stashes: number;
  worktrees: number;
  branches: number;
  remoteBranches: number;
  reclaimBytes: number;
}

export interface ScanJobInfo {
  key: string;
  startedAt: number;
  phase: string;
  done: number;
  total: number;
}

export interface RepoSummary {
  key: string;
  name: string;
  root: string;
  addedAt: number;
  deploy: DeployConfig | null;
  lastHealth: { at: number; totals: HealthTotals; deployBranch?: string } | null;
  scanning: ScanJobInfo | null;
  exists: boolean;
}

export interface PullRequestInfo {
  number: number;
  state: "MERGED" | "OPEN" | "CLOSED";
  url?: string;
  title?: string;
  baseRefName?: string;
  mergedAt?: string;
}

export interface BranchRow {
  name: string;
  shortName: string;
  kind: "local" | "remote";
  remote?: string;
  sha: string;
  lastCommitAt: number;
  author?: string;
  subject?: string;
  upstream?: string;
  upstreamGone?: boolean;
  ahead?: number;
  behind?: number;
  mergedBy?: MergedBy | null;
  uniqueCommits?: number;
  inOriginDeploy?: boolean;
  pr?: PullRequestInfo;
  worktreePaths: string[];
  group: HealthGroup;
  reasons: string[];
  uniqueWork: boolean;
}

export interface WorktreeRow {
  path: string;
  branch?: string;
  head: string;
  main: boolean;
  detached: boolean;
  locked?: boolean;
  prunable?: boolean;
  missing?: boolean;
  dirty: boolean;
  dirtyCount: number;
  dirtySample?: string[];
  sizeBytes?: number;
  activeBy: string[];
  lastActivityAt?: number;
  group: HealthGroup;
  reasons: string[];
  uniqueWork: boolean;
}

export interface StashRow {
  ref: string;
  sha: string;
  message: string;
  branch?: string;
  at: number;
  files: number;
  inDeploy?: boolean;
}

export interface HealthReport {
  repoKey?: string;
  name: string;
  root: string;
  scannedAt: number;
  durationMs: number;
  deployBranch?: string;
  baseRef?: string;
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

export interface CleanupItem {
  type: "worktree" | "branch" | "remote-branch";
  name: string;
  path?: string;
  sha: string;
  branch?: string;
  sizeBytes?: number;
  reasons: string[];
}

export interface CleanupPlan {
  planId: string;
  repoRoot: string;
  repoName: string;
  deployBranch?: string;
  createdAt: number;
  items: CleanupItem[];
  skipped: Array<{ type: CleanupItem["type"]; name: string; reason: string }>;
  reclaimBytes: number;
  includeRemote: string[];
}

export interface ManifestEntry extends CleanupItem {
  status: "pending" | "deleted" | "skipped" | "failed";
  error?: string;
  backupRef?: string;
}

export interface CleanupManifest {
  id: string;
  repoRoot: string;
  repoName: string;
  createdAt: number;
  finishedAt?: number;
  entries: ManifestEntry[];
  restoredAt?: number;
  restoreLog?: Array<{ name: string; type: string; ok: boolean; note?: string }>;
  note: string;
}

export interface ManifestSummary {
  id: string;
  path: string;
  createdAt: number;
  deleted: number;
  restoredAt?: number;
}

export interface SetupState {
  setup: {
    steps: Record<string, { at: number; skipped?: boolean }>;
    repoKey?: string;
    projectId?: string;
    dismissedAt?: number;
    completedAt?: number;
  };
  scan: { daily: boolean; lastRunAt?: number };
  steps: string[];
  repos: RepoSummary[];
  developmentRoot: string;
}

export interface GithubStatus {
  installed: boolean;
  authed: boolean;
  account?: string;
  detail?: string;
}

export interface RepoRefParams {
  repoKey?: string;
  path?: string;
  projectId?: string;
}

async function rpc<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const client = await awaitGatewayClient(15_000);
  return client.request<T>(method, params, timeoutMs ? { timeoutMs } : undefined);
}

export const reposApi = {
  list: () =>
    rpc<{ repos: RepoSummary[]; projects: Record<string, string[]>; badge: number; scan: { daily: boolean; lastRunAt?: number }; setup: SetupState["setup"] }>(
      "projects.repo.repos.list",
    ),
  register: (path: string) => rpc<{ repo: RepoSummary }>("projects.repo.register", { path }),
  deployGet: (ref: RepoRefParams, probeRemote = false) =>
    rpc<{ repo: RepoSummary; deploy: DeployConfig | null; status: DeployStatus | null }>("projects.repo.deploy.get", {
      ...ref,
      probeRemote,
    }),
  suggest: (ref: RepoRefParams) => rpc<DeploySuggestion>("projects.repo.deploy.suggest", { ...ref }, 60_000),
  deploySet: (ref: RepoRefParams, cfg: Partial<DeployConfig> & { branch: string; worktreePath: string }) =>
    rpc<{ repo: RepoSummary; deploy: DeployConfig; status: DeployStatus }>("projects.repo.deploy.set", { ...ref, ...cfg }),
  deployClear: (ref: RepoRefParams) => rpc("projects.repo.deploy.clear", { ...ref }),
  healthGet: (ref: RepoRefParams) =>
    rpc<{ repo: RepoSummary; report: HealthReport | null; scanning: ScanJobInfo | null }>("projects.repo.health.get", { ...ref }),
  healthScan: (ref: RepoRefParams, opts: { wait?: boolean; sizes?: boolean } = {}) =>
    rpc<{ started?: boolean; report?: HealthReport }>("projects.repo.health.scan", { ...ref, ...opts }, opts.wait ? 300_000 : undefined),
  cleanupPreview: (ref: RepoRefParams, includeRemote: string[] = []) =>
    rpc<{ plan: CleanupPlan }>("projects.repo.cleanup.preview", { ...ref, includeRemote }, 300_000),
  cleanupExecute: (planId: string) =>
    rpc<{ manifest: CleanupManifest; manifestPath: string }>("projects.repo.cleanup.execute", { planId, confirm: true }, 600_000),
  manifests: (ref: RepoRefParams) => rpc<{ manifests: ManifestSummary[] }>("projects.repo.cleanup.manifests", { ...ref }),
  restore: (ref: RepoRefParams, id: string) =>
    rpc<{ manifest: CleanupManifest }>("projects.repo.cleanup.restore", { ...ref, id }, 600_000),
  setupGet: () => rpc<SetupState>("projects.repo.setup.get"),
  setupUpdate: (p: { step?: string; skipped?: boolean; repoKey?: string; projectId?: string; dismiss?: boolean; reset?: boolean }) =>
    rpc<{ setup: SetupState["setup"] }>("projects.repo.setup.update", p),
  github: () => rpc<GithubStatus>("projects.repo.github.status"),
  scheduleSet: (daily: boolean) => rpc<{ scan: { daily: boolean } }>("projects.repo.schedule.set", { daily }),
  clone: (url: string, dest?: string) => rpc<{ path: string; repo: RepoSummary }>("projects.repo.clone", { url, dest }, 15 * 60_000),
};

/** Subscribe to repo events (health scans, deploy changes). */
export async function onRepoEvents(
  fn: (event: string, payload: Record<string, unknown>) => void,
): Promise<() => void> {
  const client: GatewayBrowserClient = await awaitGatewayClient(15_000);
  return client.subscribe((evt) => {
    if (
      evt.event === "projects.repo.health.changed" ||
      evt.event === "projects.repo.health.progress" ||
      evt.event === "projects.repo.changed"
    ) {
      fn(evt.event, (evt.payload ?? {}) as Record<string, unknown>);
    }
  });
}

// ── Formatting ───────────────────────────────────────────────────────

export function fmtBytes(n: number | undefined): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function targetLabel(t: DeployTarget | undefined): string {
  if (!t) return "";
  const kind = { fly: "Fly app", netlify: "Netlify", vercel: "Vercel", gateway: "", docker: "Docker", other: "" }[t.kind];
  return [kind, t.name].filter(Boolean).join(" ") || t.kind;
}

export const GROUP_META: Record<HealthGroup, { label: string; hint: string }> = {
  safe: { label: "Safe to delete", hint: "Fully in the deploy branch, clean, nobody using it" },
  review: { label: "Review", hint: "Has work that is not in the deploy branch, or uncommitted changes" },
  active: { label: "Active", hint: "Recent commits or in use by a running agent / terminal" },
  protected: { label: "Protected", hint: "Deploy branch, main/master, folders in use for releases" },
};

export const MERGED_LABEL: Record<MergedBy, string> = {
  ancestor: "merged",
  cherry: "cherry-picked",
  squash: "squash-merged",
  content: "content in deploy",
  empty: "no changes",
};

/** Render a path that may only wrap after a "/" (never mid-name). */
export function pathParts(p: string | undefined): string[] {
  if (!p) return [];
  return p.split("/").map((seg, i, all) => (i < all.length - 1 ? `${seg}/` : seg));
}

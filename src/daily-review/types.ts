/**
 * Daily Review — one compact record per local calendar day describing where
 * the work went (runs, kanban, git, deploys, chat/voice, incidents) plus a
 * transparent productivity score. See docs/daily-review.md for the formula.
 */

export type RunOutcome = "verified" | "unverified" | "failed" | "needs_you" | "running";

export type WorkCategory = "code" | "video" | "deploy" | "research" | "design" | "ops" | "other";

/** One agent run as seen by the rollup (merged from every run store). */
export interface RunRecord {
  runId: string;
  label: string;
  kind: string;
  backend: string;
  project: string;
  category: WorkCategory;
  workdir?: string;
  startedAt: number;
  endedAt?: number;
  outcome: RunOutcome;
  /** Raw verdict / state strings from the verifier, when one ran. */
  verdict?: string;
  state?: string;
  kanbanTaskId?: string;
  /** Explicit respawn (ledger respawnOfRunId) — counts as rework. */
  respawnOf?: string;
  /** Logical task id: continuation passes (`<runId>-c2`, `-c3`…) share it. */
  rootId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  model?: string;
  commits: number;
  files: number;
  deploys: DeployRef[];
  telegramSends: number;
  summary?: string;
}

export interface DeployRef {
  target: string;
  ref?: string;
  label: string;
  runId?: string;
  ts: number;
}

export interface DayRun {
  runId: string;
  rootId: string;
  /** Continuation passes of the same task (-cN) before this one ended. */
  attempts?: number;
  label: string;
  project: string;
  category: WorkCategory;
  backend: string;
  kind: string;
  start: number;
  end?: number;
  outcome: RunOutcome;
  verdict?: string;
  costUsd: number;
  tokens: number;
  commits: number;
  files: number;
  deploys: number;
  rework: boolean;
  kanbanTaskId?: string;
  /** Minutes of this run that fell inside the day. */
  minutes: number;
}

export interface Bucket {
  name: string;
  runs: number;
  verified: number;
  failed: number;
  minutes: number;
  costUsd: number;
  tokens: number;
  commits: number;
}

export interface ProjectBucket extends Bucket {
  tasks: Array<{ label: string; minutes: number; outcome: RunOutcome; runId: string }>;
}

export interface HourBucket {
  h: number;
  agentMinutes: number;
  runsStarted: number;
  messages: number;
  commits: number;
  costUsd: number;
  tokens: number;
}

export interface ScoreComponent {
  key: string;
  label: string;
  count: number;
  points: number;
  note: string;
}

export interface DayScore {
  version: 1;
  value: number;
  grade: string;
  net: number;
  baseline: number;
  ratio: number;
  absolutePart: number;
  relativePart: number;
  components: ScoreComponent[];
}

export interface Accomplishment {
  title: string;
  project: string;
  kind: "run" | "deploy" | "kanban" | "merge" | "report";
  ref?: string;
  link?: string;
  weight: number;
  ts: number;
}

export interface DayTotals {
  runs: number;
  runsStarted: number;
  verified: number;
  unverified: number;
  failed: number;
  needsYou: number;
  running: number;
  rework: number;
  agentMinutes: number;
  activeHours: number;
  firstActivity?: number;
  lastActivity?: number;
  costUsd: number;
  cliCostUsd: number;
  gatewayCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  commits: number;
  merges: number;
  reposTouched: number;
  deploys: number;
  kanbanCompleted: number;
  kanbanCreated: number;
  kanbanMoved: number;
  chatMessages: number;
  voiceTurns: number;
  telegramSends: number;
  reports: number;
  incidents: number;
  oomKills: number;
  workEvents: number;
}

export interface DaySummary {
  bullets: string[];
  generatedAt: number;
  by: string;
  sentAt?: number;
}

export interface DayRollup {
  v: 1;
  date: string;
  generatedAt: number;
  partial: boolean;
  totals: DayTotals;
  byProject: ProjectBucket[];
  byBackend: Bucket[];
  byAgent: Bucket[];
  byCategory: Bucket[];
  hours: HourBucket[];
  repos: Array<{ name: string; commits: number; merges: number; project: string }>;
  runs: DayRun[];
  deploys: DeployRef[];
  accomplishments: Accomplishment[];
  inProgress: Array<{
    title: string;
    project: string;
    runId?: string;
    taskId?: string;
    since: number;
  }>;
  needsYou: Array<{ title: string; project: string; runId: string; reason: string; ts: number }>;
  kanban: {
    completed: Array<{ id: string; title: string; project: string; ts: number }>;
  };
  commitsList: Array<{ repo: string; sha: string; subject: string; ts: number; merge: boolean }>;
  reports: Array<{ name: string; path: string; ts: number }>;
  incidents: Array<{ ts: number; kind: string; detail: string }>;
  channels: Array<{ name: string; messages: number; costUsd: number }>;
  score: DayScore;
  summary?: DaySummary;
}

/** Compact per-day entry for range/history views. */
export interface DayIndexEntry {
  date: string;
  score: number;
  grade: string;
  net: number;
  verified: number;
  unverified: number;
  failed: number;
  runs: number;
  commits: number;
  deploys: number;
  costUsd: number;
  agentMinutes: number;
  kanbanCompleted: number;
  activeHours: number;
  projects: Array<{ name: string; minutes: number }>;
  categories: Array<{ name: string; minutes: number }>;
}

export interface DailyReviewConfig {
  telegram: { enabled: boolean; time: string; target: string; channel: string };
  summary: { autoTime: string; model: string };
  git: { roots: string[]; extraRepos: string[]; exclude: string[] };
  backfillFrom?: string;
}

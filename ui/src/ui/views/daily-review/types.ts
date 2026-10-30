/** UI mirror of src/daily-review/types.ts (only the fields the page reads). */

export type Outcome = "verified" | "unverified" | "failed" | "needs_you" | "running";

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

export interface DayRun {
  runId: string;
  rootId: string;
  label: string;
  project: string;
  category: string;
  backend: string;
  kind: string;
  start: number;
  end?: number;
  outcome: Outcome;
  costUsd: number;
  tokens: number;
  commits: number;
  minutes: number;
  kanbanTaskId?: string;
}

export interface DayRollup {
  date: string;
  generatedAt: number;
  partial: boolean;
  empty?: boolean;
  totals: {
    runs: number;
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
    chatMessages: number;
    voiceTurns: number;
    telegramSends: number;
    reports: number;
    incidents: number;
    oomKills: number;
  };
  byProject: Array<Bucket & { tasks: Array<{ label: string; minutes: number; outcome: string; runId: string }> }>;
  byBackend: Bucket[];
  byAgent: Bucket[];
  byCategory: Bucket[];
  hours: Array<{ h: number; agentMinutes: number; runsStarted: number; messages: number; commits: number; costUsd: number; tokens: number }>;
  repos: Array<{ name: string; commits: number; merges: number; project?: string }>;
  runs: DayRun[];
  deploys: Array<{ target: string; ref?: string; label: string; runId?: string; ts: number }>;
  accomplishments: Array<{ title: string; project: string; kind: string; ref?: string; link?: string; weight: number; ts: number }>;
  inProgress: Array<{ title: string; project: string; runId?: string; taskId?: string; since: number }>;
  needsYou: Array<{ title: string; project: string; runId: string; reason: string; ts: number }>;
  kanban: { completed: Array<{ id: string; title: string; project: string; ts: number }> };
  commitsList: Array<{ repo: string; sha: string; subject: string; ts: number; merge: boolean }>;
  reports: Array<{ name: string; path: string; ts: number }>;
  incidents: Array<{ ts: number; kind: string; detail: string }>;
  channels: Array<{ name: string; messages: number; costUsd: number }>;
  score: {
    value: number;
    grade: string;
    net: number;
    baseline: number;
    ratio: number;
    absolutePart: number;
    relativePart: number;
    components: Array<{ key: string; label: string; count: number; points: number; note: string }>;
  };
  summary?: { bullets: string[]; generatedAt: number; by: string; sentAt?: number };
}

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

export interface ReviewConfig {
  telegram: { enabled: boolean; time: string; target: string; channel: string };
  summary: { autoTime: string; model: string };
}

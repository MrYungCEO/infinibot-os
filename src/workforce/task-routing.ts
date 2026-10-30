/**
 * Task routing — the missing bridge between real agency work and the workforce.
 *
 * `agency_tasks` carried `assignee_type`/`assignee_id` columns that nothing ever
 * wrote, so thousands of real tasks were invisible to the AI employees and the
 * operating loop could only materialise work from recurring responsibilities.
 * This module closes that gap:
 *
 *   1. read a task's own words (title, description, acceptance criteria) plus
 *      its project name, and derive what the work actually requires;
 *   2. score every active worker with the EXISTING `scoreWorkerSuitability`
 *      engine — no second, divergent notion of "good fit";
 *   3. pick the best-suited worker that still has genuine headroom;
 *   4. explain the choice, in writing, including the runner-up;
 *   5. leave work that is not confidently understood UNASSIGNED and flagged for
 *      a human, rather than forcing a bad fit.
 *
 * Everything here is pure. No database handle, no clock, no I/O — which is what
 * makes it cheap enough to run over thousands of tasks inside one tick and
 * trivial to test. Persistence lives in `routing-store.ts`, orchestration in
 * `task-router.ts`.
 */

import { createHash } from "node:crypto";

import { scoreWorkerSuitability } from "./suitability.js";
import type { SkillRequirement, Worker, WorkerCapacity } from "./types.js";
import type { TaskAutostageMode } from "./routing-store.js";

/** A routable task, structurally compatible with `AgencyTask`. */
export type RoutableTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
  priority: "low" | "normal" | "high" | "urgent";
  assigneeType: "human" | "ai" | "hybrid" | null;
  assigneeId: string | null;
  dueAt: number | null;
};

/** A routable project, structurally compatible with `AgencyProject`. */
export type RoutableProject = { id: string; name: string; status: string };

export type TaskRoutingOutcome =
  /** A worker was chosen and the task is theirs. */
  | "assigned"
  /** Understood or not, no worker clears the bar. Needs a human. */
  | "unmatched"
  /** A human deliberately removed the assignment. Pinned; never revisited. */
  | "unassigned";

export type RoutingDisciplineId =
  | "frontend"
  | "backend"
  | "architecture"
  | "marketing"
  | "delivery"
  | "executive";

type Discipline = {
  id: RoutingDisciplineId;
  label: string;
  /**
   * Evidence terms. Multi-word entries are matched as phrases; single words are
   * matched on word boundaries so "api" does not fire inside "capital".
   */
  terms: string[];
  /** Weight of one hit toward match strength. Distinctive terms weigh more. */
  strongTerms?: string[];
  requiredCapabilities: string[];
  requiredSkills: SkillRequirement[];
};

/**
 * The routing taxonomy, deliberately aligned with the capabilities and skills
 * the seeded workforce actually declares (`src/agency-operations/seed-workforce.ts`).
 * A discipline that named a capability nobody has would make every task in it
 * permanently unmatched, so these must be kept in step with the seed roles.
 *
 * At most ONE capability is required per discipline: `scoreWorkerSuitability`
 * treats a missing capability as a hard disqualification, so a long list would
 * silently make everything unroutable.
 */
export const ROUTING_DISCIPLINES: Discipline[] = [
  {
    id: "frontend",
    label: "Front end / web",
    terms: [
      "ui",
      "ux",
      "front end",
      "frontend",
      "front-end",
      "css",
      "html",
      "react",
      "landing page",
      "web page",
      "webpage",
      "website",
      "web site",
      "responsive",
      "layout",
      "mobile view",
      "wordpress",
      "webflow",
      "shopify",
      "figma",
      "mockup",
      "wireframe",
      "styling",
      "theme",
      "accessibility",
      "wcag",
      "page speed",
      "core web vitals",
      "hero section",
      "navigation",
      "design",
      "redesign",
      "banner",
      "logo placement",
      "favicon",
      "form design",
    ],
    strongTerms: [
      "front end",
      "frontend",
      "front-end",
      "css",
      "landing page",
      "wcag",
      "core web vitals",
      "responsive",
      "webflow",
      "wireframe",
    ],
    requiredCapabilities: ["frontend-implementation"],
    requiredSkills: [
      { skill: "css", minimumLevel: 3, weight: 2 },
      { skill: "typescript", minimumLevel: 3, weight: 1 },
    ],
  },
  {
    id: "backend",
    label: "Back end / automation",
    terms: [
      "api",
      "backend",
      "back end",
      "back-end",
      "endpoint",
      "database",
      "sql",
      "schema",
      "migration",
      "server",
      "integration",
      "integrate",
      "webhook",
      "automation",
      "automate",
      "script",
      "cron",
      "job",
      "queue",
      "sync",
      "zapier",
      "make.com",
      "crm sync",
      "data import",
      "export",
      "csv",
      "etl",
      "auth",
      "authentication",
      "rate limit",
      "cache",
      "worker",
    ],
    strongTerms: [
      "api",
      "backend",
      "back end",
      "back-end",
      "webhook",
      "automation",
      "automate",
      "endpoint",
      "migration",
      "etl",
      "integration",
    ],
    requiredCapabilities: ["backend-implementation"],
    requiredSkills: [
      { skill: "typescript", minimumLevel: 3, weight: 2 },
      { skill: "api-design", minimumLevel: 3, weight: 1 },
    ],
  },
  {
    id: "architecture",
    label: "Architecture / engineering quality",
    terms: [
      "architecture",
      "architectural",
      "refactor",
      "code review",
      "technical debt",
      "tech debt",
      "security",
      "vulnerability",
      "penetration",
      "ci/cd",
      "ci cd",
      "pipeline",
      "release",
      "deployment",
      "rollback",
      "incident",
      "postmortem",
      "performance audit",
      "load test",
      "dependency",
      "upgrade",
      "monorepo",
      "test coverage",
    ],
    strongTerms: [
      "architecture",
      "refactor",
      "code review",
      "technical debt",
      "tech debt",
      "ci/cd",
      "postmortem",
      "vulnerability",
    ],
    requiredCapabilities: ["architecture"],
    requiredSkills: [
      { skill: "software-architecture", minimumLevel: 4, weight: 2 },
      { skill: "code-review", minimumLevel: 4, weight: 1 },
    ],
  },
  {
    id: "marketing",
    label: "Marketing / growth",
    terms: [
      "campaign",
      "seo",
      "sem",
      "ads",
      "advertising",
      "google ads",
      "facebook ads",
      "content",
      "blog",
      "article",
      "social media",
      "instagram",
      "linkedin",
      "tiktok",
      "newsletter",
      "email marketing",
      "drip",
      "copy",
      "copywriting",
      "headline",
      "brand",
      "branding",
      "positioning",
      "funnel",
      "lead magnet",
      "landing copy",
      "outreach",
      "cold email",
      "keyword",
      "backlink",
      "press release",
      "testimonial",
      "case study",
    ],
    strongTerms: [
      "campaign",
      "seo",
      "copywriting",
      "newsletter",
      "email marketing",
      "lead magnet",
      "positioning",
      "backlink",
      "google ads",
      "case study",
    ],
    requiredCapabilities: ["campaigns"],
    requiredSkills: [
      { skill: "copywriting", minimumLevel: 3, weight: 2 },
      { skill: "positioning", minimumLevel: 3, weight: 1 },
    ],
  },
  {
    id: "delivery",
    label: "Delivery / project management",
    terms: [
      "kickoff",
      "kick off",
      "onboarding",
      "onboard",
      "schedule",
      "timeline",
      "milestone",
      "status report",
      "status update",
      "client update",
      "client call",
      "meeting",
      "agenda",
      "coordinate",
      "follow up",
      "follow-up",
      "check in",
      "check-in",
      "scope",
      "requirements",
      "handover",
      "handoff",
      "retrospective",
      "sprint",
      "backlog grooming",
      "invoice chase",
      "contract",
      "proposal",
      "estimate",
      "documentation",
      "sop",
    ],
    strongTerms: [
      "kickoff",
      "kick off",
      "onboarding",
      "status report",
      "milestone",
      "retrospective",
      "handover",
      "handoff",
      "client update",
    ],
    requiredCapabilities: ["project-management"],
    requiredSkills: [
      { skill: "delivery-management", minimumLevel: 3, weight: 2 },
      { skill: "stakeholder-communication", minimumLevel: 3, weight: 1 },
    ],
  },
  {
    id: "executive",
    label: "Executive / strategy",
    terms: [
      "strategy",
      "strategic",
      "quarterly",
      "annual plan",
      "budget",
      "pricing",
      "margin",
      "runway",
      "cash flow",
      "hiring",
      "recruit",
      "board",
      "investor",
      "partnership",
      "acquisition",
      "okr",
      "north star",
      "business model",
      "market entry",
    ],
    strongTerms: [
      "strategy",
      "quarterly",
      "budget",
      "pricing",
      "runway",
      "okr",
      "investor",
      "market entry",
    ],
    requiredCapabilities: ["strategy"],
    requiredSkills: [{ skill: "strategic-planning", minimumLevel: 4, weight: 2 }],
  },
];

/** Statuses whose tasks are worth routing. Terminal and in-flight work is not. */
export const ROUTABLE_TASK_STATUSES = new Set(["backlog", "ready"]);
/** Projects in these statuses are dormant; their tasks are not routed. */
export const NON_ROUTABLE_PROJECT_STATUSES = new Set(["completed", "cancelled"]);

/** Hours charged against capacity, scaled by the task's declared priority. */
const PRIORITY_HOURS: Record<RoutableTask["priority"], number> = {
  low: 0.75,
  normal: 1,
  high: 1.25,
  urgent: 1.5,
};

export type RoutingRequirements = {
  discipline: RoutingDisciplineId | null;
  disciplineLabel: string | null;
  /** 0-1 evidence that the task really belongs to this discipline. */
  matchStrength: number;
  /** The exact terms found, so the operator can see what the router read. */
  matchedTerms: string[];
  requiredSkills: SkillRequirement[];
  requiredCapabilities: string[];
  estimatedHours: number;
};

const WORD = /[a-z0-9+#./-]+/g;

function taskText(task: RoutableTask, project: RoutableProject | undefined): string {
  return [task.title, task.description, task.acceptanceCriteria, project?.name ?? ""]
    .join(" \n ")
    .toLowerCase();
}

function hasTerm(haystack: string, term: string): boolean {
  if (term.includes(" ") || term.includes("/")) return haystack.includes(term);
  // Word-boundary match so "api" does not fire inside "capital".
  let index = haystack.indexOf(term);
  while (index !== -1) {
    const before = index === 0 ? "" : haystack[index - 1]!;
    const after = haystack[index + term.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    index = haystack.indexOf(term, index + 1);
  }
  return false;
}

/**
 * What does this task need? Reads the task's own words plus its project name.
 *
 * Match strength is evidence, not confidence: three distinctive terms from one
 * discipline is strong evidence; one generic word is weak. A task with no
 * evidence at all returns `discipline: null`, and the caller is expected to
 * leave it for a human rather than guess.
 */
export function deriveTaskRequirements(
  task: RoutableTask,
  project?: RoutableProject,
  defaultEstimatedHours = 2,
): RoutingRequirements {
  const text = taskText(task, project);
  let best: { discipline: Discipline; weight: number; terms: string[] } | null = null;

  for (const discipline of ROUTING_DISCIPLINES) {
    const strong = new Set(discipline.strongTerms ?? []);
    const terms: string[] = [];
    let weight = 0;
    for (const term of discipline.terms) {
      if (!hasTerm(text, term)) continue;
      terms.push(term);
      weight += strong.has(term) ? 2 : 1;
    }
    if (!weight) continue;
    if (!best || weight > best.weight) best = { discipline, weight, terms };
  }

  const words = text.match(WORD)?.length ?? 0;
  const estimatedHours =
    Math.round(
      Math.min(
        16,
        Math.max(
          0.5,
          defaultEstimatedHours * PRIORITY_HOURS[task.priority] * (words > 120 ? 1.5 : 1),
        ),
      ) * 4,
    ) / 4;

  if (!best) {
    return {
      discipline: null,
      disciplineLabel: null,
      matchStrength: 0,
      matchedTerms: [],
      requiredSkills: [],
      requiredCapabilities: [],
      estimatedHours,
    };
  }

  // Four weighted points (e.g. two distinctive terms) is treated as full
  // evidence. Below that the strength degrades linearly and honestly.
  const matchStrength = Math.round(Math.min(1, best.weight / 4) * 100) / 100;
  return {
    discipline: best.discipline.id,
    disciplineLabel: best.discipline.label,
    matchStrength,
    matchedTerms: best.terms.slice(0, 8),
    requiredSkills: best.discipline.requiredSkills,
    requiredCapabilities: best.discipline.requiredCapabilities,
    estimatedHours,
  };
}

export type TaskRoutingDecision = {
  agencyId: string;
  taskId: string;
  projectId: string | null;
  taskTitle: string;
  outcome: TaskRoutingOutcome;
  workerId: string | null;
  workerName: string | null;
  assigneeType: "ai" | "human" | null;
  discipline: string | null;
  matchStrength: number;
  matchedTerms: string[];
  /** Suitability score 0-100 from `scoreWorkerSuitability`. */
  score: number;
  skillCoverage: number;
  /** Blended 0-1 confidence: evidence the task was understood AND fits. */
  confidence: number;
  matchedSkills: string[];
  missingSkills: string[];
  estimatedHours: number;
  runnerUp: { workerId: string; workerName: string | null; score: number } | null;
  /** Plain-English explanation, persisted so the operator can audit it. */
  rationale: string;
  /** True when a human must look at this: unmatched, or low confidence. */
  needsHuman: boolean;
  /** True when this pass moved the card into the execution stage. */
  autoStaged: boolean;
  /** True when the card clears every bar but policy stops short of staging. */
  stageRecommended: boolean;
  /** Why it was (or was not) staged. */
  stageReason: string;
  /** Content+pool fingerprint. Equal signature ⇒ nothing to redo. */
  signature: string;
};

export type TaskRoutingLimits = {
  minScore: number;
  minMatchStrength: number;
  maxAssignmentsPerPass: number;
  maxTasksPerWorkerPerPass: number;
  capacityHeadroom: number;
  defaultEstimatedHours: number;
};

export type TaskAutostageLimits = {
  mode: TaskAutostageMode;
  minConfidence: number;
  minAutonomyLevel: number;
  /** Remaining budget for this pass after the daily cap is applied. */
  budget: number;
  workerModes: Record<string, TaskAutostageMode>;
};

export type TaskRoutingPlanInput = {
  agencyId: string;
  tasks: RoutableTask[];
  projects: Map<string, RoutableProject>;
  workers: Worker[];
  /** Capacity per worker, as reported by `WorkforceStore.getWorkloadSummary`. */
  capacities: Map<string, WorkerCapacity>;
  /** Hours already committed by previously routed, still-open tasks. */
  routedHours: Map<string, number>;
  /** Task ids whose stored decision is still valid — skipped without scoring. */
  unchangedSignatures: Map<string, string>;
  /** Task ids a human has pinned. Never revisited by the router. */
  pinnedTaskIds: Set<string>;
  limits: TaskRoutingLimits;
  autostage: TaskAutostageLimits;
};

export type TaskRoutingPlan = {
  decisions: TaskRoutingDecision[];
  /** Tasks whose stored decision was still valid. Zero work, zero writes. */
  skipped: number;
  /** Tasks a human pinned. */
  pinned: number;
  /** Tasks left for the next pass because a per-pass cap was reached. */
  deferred: number;
  /** Per-worker projected load after this plan, for the report. */
  load: Array<{ workerId: string; workerName: string; assigned: number; hoursLeft: number }>;
};

/** The workforce shape. Changing it invalidates every cached decision. */
export function workerPoolFingerprint(workers: Worker[]): string {
  const body = workers
    .map((worker) =>
      JSON.stringify([
        worker.id,
        worker.employmentStatus,
        worker.type,
        worker.autonomyLevel,
        worker.costRate,
        worker.capabilities.slice().sort(),
        worker.skills.map((skill) => [skill.skill, skill.level]).sort(),
      ]),
    )
    .sort()
    .join("|");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * Fingerprint of everything that could change a task's routing decision: the
 * task's own content, the worker pool, and the thresholds. Equal fingerprint
 * means re-running is provably pointless — which is how a second pass over an
 * unchanged agency performs zero writes.
 *
 * Deliberately EXCLUDES `assigneeId`: the router writes that field itself, so
 * including it would invalidate every decision the moment it was applied and
 * the pass would never converge. A human reassigning a task instead is caught
 * by the candidate filter in `task-router.ts`, which stops routing a task whose
 * assignee no longer matches the recorded decision.
 */
export function taskRoutingSignature(
  task: RoutableTask,
  poolFingerprint: string,
  limits: TaskRoutingLimits,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        task.title,
        task.description,
        task.acceptanceCriteria,
        task.status,
        task.priority,
        task.projectId,
        poolFingerprint,
        limits.minScore,
        limits.minMatchStrength,
        limits.capacityHeadroom,
        limits.defaultEstimatedHours,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

/** Routing capacity: effective hours, minus committed work, minus headroom. */
function routingHoursLeft(
  capacity: WorkerCapacity | undefined,
  routedHours: number,
  headroom: number,
): number {
  if (!capacity) return 0;
  const usable = capacity.effectiveCapacityHours * (1 - headroom);
  return Math.max(0, usable - capacity.allocatedHours - routedHours);
}

/**
 * Plan the routing of a batch of tasks. Pure: same input, same output.
 *
 * Cost is O(tasks × workers) scoring calls with no I/O of any kind — 2,853
 * tasks over 11 workers is ~31k in-memory scores. Skipped (unchanged) tasks
 * cost one hash each and are never scored.
 */
export function planTaskRouting(input: TaskRoutingPlanInput): TaskRoutingPlan {
  const { limits, autostage } = input;
  const poolFingerprint = workerPoolFingerprint(input.workers);
  const candidates = input.workers.filter(
    (worker) => worker.employmentStatus === "active" && worker.type === "ai",
  );
  const workerById = new Map(candidates.map((worker) => [worker.id, worker]));

  const hoursLeft = new Map<string, number>();
  const assignedCount = new Map<string, number>();
  for (const worker of candidates) {
    hoursLeft.set(
      worker.id,
      routingHoursLeft(
        input.capacities.get(worker.id),
        input.routedHours.get(worker.id) ?? 0,
        limits.capacityHeadroom,
      ),
    );
    assignedCount.set(worker.id, 0);
  }

  const decisions: TaskRoutingDecision[] = [];
  let skipped = 0;
  let pinned = 0;
  let deferred = 0;
  let staged = 0;
  /**
   * The per-pass cap counts ASSIGNMENTS, not decisions. Recording "nobody can
   * take this" costs one small row and never repeats, so letting it consume the
   * budget would starve genuinely new work behind a permanent backlog of
   * unroutable tasks — which is exactly the failure mode this engine exists to
   * remove.
   */
  let assignments = 0;

  for (const task of input.tasks) {
    if (input.pinnedTaskIds.has(task.id)) {
      pinned += 1;
      continue;
    }
    const signature = taskRoutingSignature(task, poolFingerprint, limits);
    if (input.unchangedSignatures.get(task.id) === signature) {
      skipped += 1;
      continue;
    }
    if (assignments >= limits.maxAssignmentsPerPass) {
      deferred += 1;
      continue;
    }

    const project = input.projects.get(task.projectId);
    const requirements = deriveTaskRequirements(task, project, limits.defaultEstimatedHours);
    const base = {
      agencyId: input.agencyId,
      taskId: task.id,
      projectId: task.projectId ?? null,
      taskTitle: task.title,
      discipline: requirements.discipline,
      matchStrength: requirements.matchStrength,
      matchedTerms: requirements.matchedTerms,
      estimatedHours: requirements.estimatedHours,
      signature,
    };

    // 1. Not understood. Say so; do not guess.
    if (!requirements.discipline || requirements.matchStrength < limits.minMatchStrength) {
      decisions.push({
        ...base,
        outcome: "unmatched",
        workerId: null,
        workerName: null,
        assigneeType: null,
        score: 0,
        skillCoverage: 0,
        confidence: 0,
        matchedSkills: [],
        missingSkills: [],
        runnerUp: null,
        needsHuman: true,
        autoStaged: false,
        stageRecommended: false,
        stageReason: "not staged: no confident match",
        rationale: requirements.discipline
          ? `Weak evidence for ${requirements.disciplineLabel} (strength ${requirements.matchStrength.toFixed(2)} < ${limits.minMatchStrength}). Left unassigned for a human to classify.`
          : "No recognisable discipline in the task's title, description or acceptance criteria. Left unassigned for a human to classify.",
      });
      continue;
    }

    // 2. Score the whole bench with the existing engine, against the capacity
    //    this pass has actually left free.
    const ranked = candidates
      .map((worker) => {
        const capacity = input.capacities.get(worker.id);
        const remaining = hoursLeft.get(worker.id) ?? 0;
        const projected: WorkerCapacity = {
          workerId: worker.id,
          displayName: worker.displayName,
          type: worker.type,
          weeklyCapacityHours: capacity?.weeklyCapacityHours ?? worker.weeklyCapacityHours,
          effectiveCapacityHours: capacity?.effectiveCapacityHours ?? 0,
          allocatedHours: capacity?.allocatedHours ?? 0,
          loggedHours: capacity?.loggedHours ?? 0,
          remainingHours: remaining,
          utilizationPercent: capacity?.utilizationPercent ?? 0,
          overAllocated: capacity?.overAllocated ?? false,
        };
        const atPassLimit = (assignedCount.get(worker.id) ?? 0) >= limits.maxTasksPerWorkerPerPass;
        const result = scoreWorkerSuitability(worker, projected, {
          requiredSkills: requirements.requiredSkills,
          requiredCapabilities: requirements.requiredCapabilities,
          estimatedHours: requirements.estimatedHours,
          preferredType: "ai",
        });
        return {
          worker,
          result,
          eligible: result.eligible && !atPassLimit,
          atPassLimit,
        };
      })
      .sort((a, b) => b.result.score - a.result.score || a.worker.costRate - b.worker.costRate);

    const winner = ranked.find((entry) => entry.eligible && entry.result.score >= limits.minScore);
    const runnerUpEntry = winner
      ? ranked.find((entry) => entry.worker.id !== winner.worker.id)
      : null;
    const runnerUp = runnerUpEntry
      ? {
          workerId: runnerUpEntry.worker.id,
          workerName: runnerUpEntry.worker.displayName,
          score: runnerUpEntry.result.score,
        }
      : null;

    // 3. Nobody clears the bar. Honest failure beats a bad fit.
    if (!winner) {
      const top = ranked[0];
      // Deliberately CATEGORICAL, never numeric. This branch is re-evaluated on
      // every pass (understood work must be retried when capacity frees), so a
      // rationale containing a live float would rewrite the row every 15
      // minutes forever — the exact churn that once grew this database to
      // 633 MB.
      const why = !top
        ? "no active AI employee exists"
        : top.result.missingCapabilities.length
          ? `no active employee has the required capability (${top.result.missingCapabilities.join(", ")})`
          : top.result.missingSkills.length
            ? `no active employee covers the required skills (${top.result.missingSkills.join(", ")})`
            : "every suitable employee is at capacity or at its per-pass limit";
      decisions.push({
        ...base,
        outcome: "unmatched",
        workerId: null,
        workerName: null,
        assigneeType: null,
        // Stable fields only, for the same anti-churn reason as `why`: the
        // suitability score moves with live capacity, so persisting it on a
        // row that is re-derived every pass would rewrite it every pass.
        score: 0,
        skillCoverage: top?.result.skillCoverage ?? 0,
        confidence: 0,
        matchedSkills: [],
        missingSkills: top?.result.missingSkills ?? [],
        runnerUp: null,
        needsHuman: true,
        autoStaged: false,
        stageRecommended: false,
        stageReason: "not staged: no eligible employee",
        rationale: `${requirements.disciplineLabel} work, but no employee could take it: ${why}. Left unassigned for a human.`,
      });
      continue;
    }

    const required = requirements.requiredSkills.map((entry) => entry.skill);
    const missing = new Set(winner.result.missingSkills.map((value) => value.toLowerCase()));
    const matchedSkills = required.filter((skill) => !missing.has(skill.toLowerCase()));

    // Confidence blends "did we understand the task" with "does this employee
    // actually fit". Both must be true; either being weak drags it down.
    const confidence =
      Math.round((requirements.matchStrength * 0.4 + (winner.result.score / 100) * 0.6) * 100) /
      100;

    const workerMode = autostage.workerModes[winner.worker.id] ?? autostage.mode;
    const stage = decideAutoStage({
      mode: workerMode,
      confidence,
      minConfidence: autostage.minConfidence,
      autonomyLevel: winner.worker.autonomyLevel,
      minAutonomyLevel: autostage.minAutonomyLevel,
      budgetLeft: autostage.budget - staged,
      workerName: winner.worker.displayName,
    });
    if (stage.autoStaged) staged += 1;

    hoursLeft.set(
      winner.worker.id,
      Math.max(0, (hoursLeft.get(winner.worker.id) ?? 0) - requirements.estimatedHours),
    );
    assignedCount.set(winner.worker.id, (assignedCount.get(winner.worker.id) ?? 0) + 1);
    assignments += 1;

    decisions.push({
      ...base,
      outcome: "assigned",
      workerId: winner.worker.id,
      workerName: winner.worker.displayName,
      assigneeType: "ai",
      score: winner.result.score,
      skillCoverage: winner.result.skillCoverage,
      confidence,
      matchedSkills,
      missingSkills: winner.result.missingSkills,
      runnerUp,
      needsHuman: confidence < autostage.minConfidence,
      autoStaged: stage.autoStaged,
      stageRecommended: stage.recommended,
      stageReason: stage.reason,
      rationale: explain({
        discipline: requirements.disciplineLabel ?? "General",
        matchedTerms: requirements.matchedTerms,
        matchStrength: requirements.matchStrength,
        workerName: winner.worker.displayName,
        workerTitle: winner.worker.title,
        score: winner.result.score,
        skillCoverage: winner.result.skillCoverage,
        matchedSkills,
        estimatedHours: requirements.estimatedHours,
        hoursLeft: hoursLeft.get(winner.worker.id) ?? 0,
        runnerUp,
        stageReason: stage.reason,
      }),
    });
  }

  return {
    decisions,
    skipped,
    pinned,
    deferred,
    load: candidates.map((worker) => ({
      workerId: worker.id,
      workerName: workerById.get(worker.id)?.displayName ?? worker.id,
      assigned: assignedCount.get(worker.id) ?? 0,
      hoursLeft: Math.round((hoursLeft.get(worker.id) ?? 0) * 100) / 100,
    })),
  };
}

/**
 * Should this card be handed straight to the executor?
 *
 * Autonomy still governs what happens next (`decideAutonomy` in executor.ts):
 * level 0 never executes, level 1 always lands in review, level 2 auto-completes
 * only under its approval threshold, level 3 auto-completes. Staging a level-0
 * worker's card would just park it in a column it can never leave, so we don't.
 */
export function decideAutoStage(input: {
  mode: TaskAutostageMode;
  confidence: number;
  minConfidence: number;
  autonomyLevel: number;
  minAutonomyLevel: number;
  budgetLeft: number;
  workerName: string;
}): { autoStaged: boolean; recommended: boolean; reason: string } {
  if (input.mode === "off") {
    return { autoStaged: false, recommended: false, reason: "not staged: autostage is off" };
  }
  if (input.confidence < input.minConfidence) {
    return {
      autoStaged: false,
      recommended: false,
      reason: `not staged: confidence ${input.confidence.toFixed(2)} below ${input.minConfidence}`,
    };
  }
  if (input.autonomyLevel <= 0) {
    return {
      autoStaged: false,
      recommended: false,
      reason: `not staged: ${input.workerName} is autonomy level 0 (observed, not trusted to act)`,
    };
  }
  if (input.autonomyLevel < input.minAutonomyLevel) {
    return {
      autoStaged: false,
      recommended: true,
      reason: `recommended: ${input.workerName} is autonomy level ${input.autonomyLevel}, policy stages at ${input.minAutonomyLevel}+`,
    };
  }
  if (input.mode === "recommend") {
    return {
      autoStaged: false,
      recommended: true,
      reason: "recommended: policy is route-and-recommend, staging is one action away",
    };
  }
  if (input.budgetLeft <= 0) {
    return {
      autoStaged: false,
      recommended: true,
      reason: "recommended: auto-stage budget for this pass/day is exhausted",
    };
  }
  return {
    autoStaged: true,
    recommended: true,
    reason: `staged: confidence ${input.confidence.toFixed(2)} at autonomy level ${input.autonomyLevel}`,
  };
}

function explain(input: {
  discipline: string;
  matchedTerms: string[];
  matchStrength: number;
  workerName: string;
  workerTitle: string;
  score: number;
  skillCoverage: number;
  matchedSkills: string[];
  estimatedHours: number;
  hoursLeft: number;
  runnerUp: { workerName: string | null; score: number } | null;
  stageReason: string;
}): string {
  const evidence = input.matchedTerms.length
    ? `matched ${input.discipline} on "${input.matchedTerms.slice(0, 4).join('", "')}" (strength ${input.matchStrength.toFixed(2)})`
    : `classified as ${input.discipline}`;
  const skills = input.matchedSkills.length
    ? `covers ${input.matchedSkills.join(", ")}`
    : "covers the required capability";
  const runner = input.runnerUp?.workerName
    ? ` Runner-up ${input.runnerUp.workerName} scored ${input.runnerUp.score}.`
    : "";
  return (
    `Routed to ${input.workerName} (${input.workerTitle}): ${evidence}; ` +
    `${skills} with suitability ${input.score}/100 and ${Math.round(input.skillCoverage * 100)}% skill coverage. ` +
    `Reserves ~${input.estimatedHours}h, leaving ${input.hoursLeft.toFixed(1)}h of routing headroom.${runner} ` +
    `${input.stageReason}.`
  );
}

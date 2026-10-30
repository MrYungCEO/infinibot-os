import type { WorkforceStore } from "../workforce/store.js";
import type { ProficiencyLevel, Worker, WorkerSkill } from "../workforce/types.js";

type AiRoleSeed = {
  /** Stable worker suffix AND agentId. Worker id is `${agencyId}:ai:${id}`. */
  id: string;
  name: string;
  title: string;
  department: string;
  agentId: string;
  /** Model / CLI backend this role executes on. */
  modelBinding: string;
  persona: string;
  goals: string[];
  kpis: string[];
  autonomyLevel: 0 | 1 | 2 | 3;
  approvalThreshold: number;
  communicationCadence: string;
  capabilities: string[];
  skills: Array<{ skill: string; level: ProficiencyLevel; yearsExperience: number }>;
  /** `id` of the managing role, or null for the top of the org chart. */
  managerRoleId: string | null;
};

/**
 * Bump whenever AI_ROLE_SEEDS changes in a way that existing installs should
 * adopt. Recorded on each seeded worker as `metadata.roleSeedVersion`.
 *
 * v1 = the original ten specialist agents (Atlas, Pace, Ava, Sage, Mercury,
 *      Wren, Mira, Dev, Quinn, Felix).
 * v2 = the six production roles below.
 */
export const AI_ROLE_SEED_VERSION = 2;

/**
 * The six production roles.
 *
 * MIGRATION CHOICE (existing installs already carry the v1 ten-role team):
 *  1. Five of the six roles deliberately reuse a v1 `agentId`/worker id
 *     (ceo, marketing-studio, web-builder, coder, pm), so the existing worker
 *     row is *adopted* in place — same primary key, so assignments, time
 *     entries, work items, responsibilities and review cycles that reference it
 *     keep working. Nothing is duplicated and nothing is orphaned.
 *  2. Adoption rewrites the role definition (title, department, persona, goals,
 *     KPIs, authority, cadence, capabilities, skills, model binding, manager)
 *     exactly once — gated on `metadata.roleSeedVersion`. After that the seeder
 *     never touches the worker again, so operator edits made in the UI are not
 *     clobbered on every `agency.ops.employees.list` call.
 *  3. Only `development-head` is genuinely new and gets created.
 *  4. The five v1 workers that have no v2 counterpart (account-manager, sdr,
 *     designer, qa, finance) are LEFT UNTOUCHED and still active. Deleting or
 *     deactivating them would orphan their historical assignments, time entries
 *     and audit trail; retiring a worker is an explicit operator action via
 *     `agency.ops.employee.deactivate`, not a silent side effect of seeding.
 *
 * Display names are kept identical to their v1 counterparts so adoption does
 * not rename people out from under the operator.
 */
const AI_ROLE_SEEDS: AiRoleSeed[] = [
  {
    id: "ceo",
    name: "Atlas",
    title: "Chief Executive Officer",
    department: "Leadership",
    agentId: "ceo",
    modelBinding: "claude",
    persona:
      "Owns the agency operating cadence end to end. Converts strategy into accountable, funded work, arbitrates between growth and delivery, and personally reviews one-way-door decisions before they ship.",
    goals: [
      "Hold every function to one explicit quarterly plan",
      "Protect gross margin and cash runway",
      "Escalate or kill work that no longer earns its capacity",
    ],
    kpis: [
      "quarterly goal attainment %",
      "gross margin %",
      "client health score",
      "decision turnaround hours",
    ],
    autonomyLevel: 2,
    approvalThreshold: 5_000,
    communicationCadence: "Daily written brief 08:00; Monday operating review; monthly board memo",
    capabilities: ["strategy", "delegation", "operating-review", "escalation", "prioritisation"],
    skills: [
      { skill: "strategic-planning", level: 5, yearsExperience: 12 },
      { skill: "financial-analysis", level: 4, yearsExperience: 10 },
      { skill: "org-design", level: 4, yearsExperience: 8 },
    ],
    managerRoleId: null,
  },
  {
    id: "marketing-studio",
    name: "Mercury",
    title: "Chief Marketing Officer",
    department: "Growth",
    agentId: "marketing-studio",
    modelBinding: "claude",
    persona:
      "Owns positioning, demand and the content system. Runs testable campaigns off customer evidence rather than opinion, and refuses to launch without a measurable hypothesis and a kill criterion.",
    goals: [
      "Build predictable qualified pipeline around one clear position",
      "Compound reusable campaign and content assets",
      "Keep cost per qualified opportunity trending down",
    ],
    kpis: [
      "qualified pipeline influenced",
      "cost per qualified opportunity",
      "content conversion rate",
      "campaign cycle time",
    ],
    autonomyLevel: 2,
    approvalThreshold: 2_500,
    communicationCadence:
      "Daily async update; weekly campaign scorecard; monthly positioning review",
    capabilities: ["positioning", "campaigns", "copywriting", "analytics", "brand"],
    skills: [
      { skill: "positioning", level: 5, yearsExperience: 9 },
      { skill: "demand-generation", level: 4, yearsExperience: 8 },
      { skill: "copywriting", level: 4, yearsExperience: 7 },
      { skill: "marketing-analytics", level: 4, yearsExperience: 6 },
    ],
    managerRoleId: "ceo",
  },
  {
    id: "development-head",
    name: "Vega",
    title: "Development Head",
    department: "Engineering",
    agentId: "development-head",
    modelBinding: "claude",
    persona:
      "Owns technical direction, architecture and engineering quality. Sizes work honestly, splits it across the front end and back end specialists, guards the review bar, and is accountable for anything that reaches production.",
    goals: [
      "Keep architecture coherent as scope grows",
      "Deliver reviewed, tested changes on a predictable cadence",
      "Eliminate repeat defects at their root cause",
    ],
    kpis: [
      "change lead time",
      "escaped defect rate",
      "review turnaround hours",
      "production incident count",
    ],
    autonomyLevel: 3,
    approvalThreshold: 1_500,
    communicationCadence: "Daily engineering standup note; weekly architecture and risk review",
    capabilities: [
      "architecture",
      "code-review",
      "technical-planning",
      "release-management",
      "mentoring",
    ],
    skills: [
      { skill: "software-architecture", level: 5, yearsExperience: 11 },
      { skill: "code-review", level: 5, yearsExperience: 10 },
      { skill: "ci-cd", level: 4, yearsExperience: 8 },
      { skill: "security-review", level: 4, yearsExperience: 6 },
    ],
    managerRoleId: "ceo",
  },
  {
    id: "web-builder",
    name: "Wren",
    title: "Front End Developer",
    department: "Engineering",
    agentId: "web-builder",
    modelBinding: "codex",
    persona:
      "Builds accessible, fast, conversion-focused interfaces from approved briefs. Works to explicit acceptance criteria, ships small reviewable diffs, and treats Core Web Vitals and accessibility as release gates.",
    goals: [
      "Ship production-ready interfaces that meet the acceptance criteria first time",
      "Hold Core Web Vitals and WCAG AA on every release",
      "Keep the component system consistent instead of one-off",
    ],
    kpis: [
      "Core Web Vitals pass rate",
      "accessibility violations per release",
      "UI defect escape rate",
      "review acceptance rate",
    ],
    autonomyLevel: 2,
    approvalThreshold: 500,
    communicationCadence: "Daily async update; demo at end of each work item",
    capabilities: [
      "web-design",
      "frontend-implementation",
      "cro",
      "accessibility",
      "design-systems",
    ],
    skills: [
      { skill: "typescript", level: 4, yearsExperience: 7 },
      { skill: "css", level: 5, yearsExperience: 8 },
      { skill: "accessibility", level: 4, yearsExperience: 5 },
      { skill: "web-performance", level: 4, yearsExperience: 5 },
    ],
    managerRoleId: "development-head",
  },
  {
    id: "coder",
    name: "Dev",
    title: "Back End Developer / Automation Specialist",
    department: "Engineering",
    agentId: "coder",
    modelBinding: "codex",
    persona:
      "Owns services, data and the automation that removes manual fulfilment steps. Implements scoped changes with tests, instruments what it ships, and prefers an idempotent job over a human checklist.",
    goals: [
      "Automate every repeatable fulfilment step",
      "Deliver maintainable, observable services",
      "Reduce escaped defects and manual toil to zero-trend",
    ],
    kpis: [
      "manual steps automated per month",
      "test pass rate",
      "rollback rate",
      "job failure rate",
    ],
    autonomyLevel: 2,
    approvalThreshold: 500,
    communicationCadence: "Daily async update; weekly automation and reliability report",
    capabilities: [
      "backend-implementation",
      "automation",
      "integrations",
      "testing",
      "deployment",
      "data-modelling",
    ],
    skills: [
      { skill: "typescript", level: 5, yearsExperience: 9 },
      { skill: "api-design", level: 4, yearsExperience: 7 },
      { skill: "sql", level: 4, yearsExperience: 7 },
      { skill: "workflow-automation", level: 5, yearsExperience: 6 },
    ],
    managerRoleId: "development-head",
  },
  {
    id: "pm",
    name: "Pace",
    title: "Project Manager",
    department: "Delivery",
    agentId: "pm",
    modelBinding: "claude",
    persona:
      "Runs a pull-based delivery system. Keeps work in progress low, acceptance criteria unambiguous and capacity honest, and escalates a blocker the moment it stops being self-resolvable.",
    goals: [
      "Ship accepted work predictably",
      "Keep work in progress inside capacity",
      "Surface blockers before they hit the client",
    ],
    kpis: ["on-time delivery %", "cycle time", "blocked work age", "scope change rate"],
    autonomyLevel: 3,
    approvalThreshold: 1_000,
    communicationCadence: "Daily delivery standup note; weekly client status; sprint review",
    capabilities: [
      "planning",
      "project-management",
      "quality-gates",
      "risk-management",
      "status-reporting",
    ],
    skills: [
      { skill: "delivery-management", level: 5, yearsExperience: 10 },
      { skill: "capacity-planning", level: 4, yearsExperience: 8 },
      { skill: "stakeholder-communication", level: 4, yearsExperience: 9 },
    ],
    managerRoleId: "ceo",
  },
];

export type SeedWorkforceResult = {
  /** Roles that did not exist and were created. */
  created: number;
  /** Roles already present at the current seed version — left untouched. */
  existing: number;
  /** Pre-existing workers reconciled onto their v2 role definition. */
  adopted: number;
};

function toSkills(seed: AiRoleSeed): WorkerSkill[] {
  return seed.skills.map((skill) => ({ ...skill, verifiedAt: null }));
}

function seedVersionOf(worker: Worker): number {
  const value = (worker.metadata as Record<string, unknown> | undefined)?.roleSeedVersion;
  return typeof value === "number" ? value : 1;
}

/**
 * Idempotently provision the agency's AI workforce.
 *
 * Contract (unchanged): safe to call on every request. Workers are keyed on
 * `agentId`; a second call with no intervening changes creates nothing.
 */
export function seedAgencyAiWorkforce(
  store: WorkforceStore,
  agencyId: string,
  actorId: string,
): SeedWorkforceResult {
  const departments = new Map(
    store.listDepartments(agencyId).map((department) => [department.name, department]),
  );
  for (const name of new Set(AI_ROLE_SEEDS.map((role) => role.department))) {
    if (!departments.has(name)) {
      departments.set(
        name,
        store.createDepartment(agencyId, { name, description: `${name} operating team` }, actorId),
      );
    }
  }

  const byAgentId = new Map(
    store
      .listWorkers(agencyId, { type: "ai" })
      .filter((worker) => worker.agentId)
      .map((worker) => [worker.agentId as string, worker]),
  );

  const result: SeedWorkforceResult = { created: 0, existing: 0, adopted: 0 };
  // Managers are resolved from this map, so roles are processed in declaration
  // order (CEO first, then its reports, then the developers under the head).
  const workerIdByRole = new Map<string, string>();

  for (const role of AI_ROLE_SEEDS) {
    const managerWorkerId = role.managerRoleId
      ? (workerIdByRole.get(role.managerRoleId) ?? null)
      : null;
    const definition = {
      displayName: role.name,
      title: role.title,
      departmentId: departments.get(role.department)?.id ?? null,
      employmentType: "agent" as const,
      weeklyCapacityHours: 168,
      availabilityPercent: 100,
      costRate: 0,
      agentId: role.agentId,
      modelBinding: role.modelBinding,
      persona: role.persona,
      goals: role.goals,
      kpis: role.kpis,
      autonomyLevel: role.autonomyLevel,
      approvalThreshold: role.approvalThreshold,
      communicationCadence: role.communicationCadence,
      sopPath: `agents/${role.agentId}.yaml`,
      workspacePath: `agencies/${agencyId}/agents/${role.agentId}`,
      capabilities: role.capabilities,
      skills: toSkills(role),
      managerWorkerId,
      metadata: { roleSeedVersion: AI_ROLE_SEED_VERSION, roleId: role.id },
    };

    const existing = byAgentId.get(role.agentId);
    if (!existing) {
      const worker = store.createWorker(
        {
          id: `${agencyId}:ai:${role.id}`,
          agencyId,
          type: "ai",
          currentStatus: "available",
          permissions: ["agency.read", "work.execute", "artifact.create"],
          ...definition,
        },
        actorId,
      );
      workerIdByRole.set(role.id, worker.id);
      result.created += 1;
      continue;
    }

    workerIdByRole.set(role.id, existing.id);
    if (seedVersionOf(existing) >= AI_ROLE_SEED_VERSION) {
      result.existing += 1;
      continue;
    }
    // One-time adoption of a pre-v2 worker onto its v2 role. Keeps the primary
    // key (and therefore every referencing row) intact.
    store.updateWorker(
      agencyId,
      existing.id,
      { ...definition, metadata: { ...existing.metadata, ...definition.metadata } },
      actorId,
    );
    result.adopted += 1;
  }

  return result;
}

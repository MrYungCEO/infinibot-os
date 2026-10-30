/**
 * Starter SOPs for the six production roles.
 *
 * These are real procedures, not placeholder titles: every step names what the
 * employee does, what it must leave behind, and (where one exists) the RPC or
 * artefact to do it with. They are written to be executable by an AI employee
 * through `WorkItemExecutor` — `renderSopMarkdown` turns each one into the
 * "Standard operating procedure" block of the prompt — and readable by a human
 * doing the same job by hand.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────
 * Seeding is gated on `Sop.seedVersion` exactly the way `seedAgencyAiWorkforce`
 * gates on `metadata.roleSeedVersion`:
 *
 *   absent            → created
 *   seedVersion >= N  → left completely untouched (no write at all)
 *   seedVersion <  N  → reconciled onto the current definition, exactly once
 *   source=operator   → never touched; the operator owns that slug now
 *
 * So a repeat call is a true no-op and can never clobber operator edits.
 *
 * ── Schedules are NOT auto-attached ─────────────────────────────────────────
 * Seeding writes procedures only. Attaching a schedule creates a real cron job
 * and a recurring responsibility that generates work, so it stays an explicit
 * operator action (`agency.ops.sop.schedule.attach`). Each seed carries a
 * `suggestedSchedule` the UI can offer as a one-click default.
 */

import type { WorkforceSopStore } from "./sop-store.js";
import type { SopCadence, SopInput } from "./sop-types.js";

/**
 * Bump when SOP_SEEDS changes in a way existing installs should adopt.
 * v1 = the seven procedures below.
 */
export const SOP_SEED_VERSION = 1;

export type SopSeedSchedule = {
  cadence: SopCadence;
  interval: number;
  /** 0 = Sunday. Null for daily/monthly. */
  weekday: number | null;
  monthDay: number | null;
  /** HH:MM, UTC. */
  runAt: string;
  slaMinutes: number;
};

export type SopSeed = Omit<SopInput, "source" | "seedKey" | "seedVersion"> & {
  /** `agentId` of the role accountable for this SOP. */
  roleId: string;
  suggestedSchedule: SopSeedSchedule;
};

const daily = (runAt: string, slaMinutes = 480): SopSeedSchedule => ({
  cadence: "daily",
  interval: 1,
  weekday: null,
  monthDay: null,
  runAt,
  slaMinutes,
});

const weekly = (weekday: number, runAt: string, slaMinutes = 1_440): SopSeedSchedule => ({
  cadence: "weekly",
  interval: 1,
  weekday,
  monthDay: null,
  runAt,
  slaMinutes,
});

export const SOP_SEEDS: SopSeed[] = [
  // ── PM / Pace ────────────────────────────────────────────────────────────
  {
    roleId: "pm",
    slug: "pm-daily-standup-and-blocker-sweep",
    name: "Daily standup and blocker sweep",
    category: "delivery",
    summary:
      "Establish the true state of delivery every morning: what moved, what is stuck, what is at risk of missing its date. Produces one written standup note and escalates every blocker that is not self-resolvable within the day.",
    defaultPriority: "high",
    estimatedMinutes: 45,
    tags: ["delivery", "standup", "blockers", "daily"],
    suggestedSchedule: daily("08:00", 480),
    inputs: [
      {
        name: "Open work items",
        description: "Every non-terminal card from `agency.ops.employee.inbox.list`.",
        required: true,
      },
      {
        name: "Active projects and tasks",
        description: "`agency.ops.projects.list` and `agency.ops.tasks.list` for in-flight work.",
        required: true,
      },
      {
        name: "Yesterday's standup note",
        description: "The previous run's note, for comparison. Absent on the first run.",
        required: false,
      },
    ],
    steps: [
      {
        title: "Pull the current delivery state",
        instruction:
          "List every work item that is not completed or cancelled, and every project not in a terminal status. Record for each: owner, status, age in its current status, and due date.",
        expectedOutput:
          "A complete inventory of in-flight work with owner, status, age and due date. No item omitted.",
        toolHint: "agency.ops.employee.inbox.list, agency.ops.projects.list, agency.ops.tasks.list",
        required: true,
      },
      {
        title: "Diff against yesterday",
        instruction:
          "Compare against the previous standup note. Classify every item as moved, unchanged, newly blocked, or newly at risk. An item unchanged for two consecutive runs is treated as stalled regardless of what its owner says.",
        expectedOutput:
          "Each in-flight item labelled moved / unchanged / newly-blocked / at-risk, plus an explicit stalled list.",
        required: true,
      },
      {
        title: "Identify and classify blockers",
        instruction:
          "For every blocked, escalated or stalled item, write the specific blocker in one sentence, name who or what must act, and classify it as: self-resolvable today, needs another employee, needs the client, or needs an operator decision.",
        expectedOutput:
          "One-line blocker statement per blocked item with a named owner and a classification. No blocker left as 'waiting'.",
        required: true,
      },
      {
        title: "Check work in progress against capacity",
        instruction:
          "Compare each employee's in-progress count and allocated hours against their capacity. Flag anyone above capacity, and anyone with zero in-progress work while backlog exists.",
        expectedOutput:
          "A per-employee WIP-vs-capacity line, with over-capacity and idle employees explicitly named.",
        toolHint: "agency.ops.employees.list",
        required: true,
      },
      {
        title: "Escalate what cannot be resolved today",
        instruction:
          "Escalate every blocker classified as needing the client or an operator decision, plus anything stalled two runs running. State the decision required and the cost of a further day's delay.",
        expectedOutput:
          "An escalation per qualifying blocker, each naming the decision required and the cost of delay.",
        toolHint: "agency.ops.employee.work-item.transition (status escalated)",
        required: true,
      },
      {
        title: "Write and file the standup note",
        instruction:
          "Publish a note with four sections: Shipped since yesterday, In flight (with dates), Blocked (with owner and ask), At risk (with mitigation). Keep it under 400 words. File it to job memory so tomorrow's run can diff against it.",
        expectedOutput:
          "A filed standup note under 400 words containing all four sections, retrievable by the next run.",
        toolHint: "agency.ops.employee.memory.upsert (namespace `delivery-standup`)",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Daily standup note",
        description: "Four-section written note, under 400 words.",
        required: true,
      },
      {
        name: "Blocker register",
        description: "Every blocker with owner, classification and ask.",
        required: true,
      },
      {
        name: "Escalations",
        description: "Work items transitioned to escalated with a stated decision required.",
        required: false,
      },
    ],
    acceptanceCriteria: [
      "Every non-terminal work item appears exactly once in the note",
      "Every blocked or stalled item names a specific person or decision, never just 'waiting'",
      "Anything stalled for two consecutive runs has been escalated",
      "The note is filed to job memory so the next run can diff against it",
      "The note is under 400 words",
    ],
  },

  {
    roleId: "pm",
    slug: "pm-weekly-client-status-report",
    name: "Weekly client status report",
    category: "delivery",
    summary:
      "One honest status report per active client engagement: what shipped, what is next, what slipped and why, and what the client must decide. Sent before the client has to ask.",
    defaultPriority: "high",
    estimatedMinutes: 90,
    tags: ["delivery", "client", "reporting", "weekly"],
    suggestedSchedule: weekly(5, "13:00", 1_440),
    inputs: [
      { name: "Active engagements", description: "`agency.ops.engagements.list`.", required: true },
      {
        name: "Per-client project and task state",
        description: "Scoped by client id.",
        required: true,
      },
      { name: "Last week's report", description: "For commitment tracking.", required: false },
    ],
    steps: [
      {
        title: "Enumerate reportable engagements",
        instruction:
          "List every active engagement and its client. Skip nothing — an engagement with no progress still gets a report saying so.",
        expectedOutput: "A complete list of active engagements requiring a report this week.",
        toolHint: "agency.ops.engagements.list, agency.ops.clients.list",
        required: true,
      },
      {
        title: "Score last week's commitments",
        instruction:
          "For each engagement, take every commitment made in last week's report and mark it met, missed or moved. A missed commitment is reported as missed; it is never quietly re-dated.",
        expectedOutput:
          "Every prior commitment explicitly scored met / missed / moved, with a reason for each miss.",
        required: true,
      },
      {
        title: "Assemble what actually shipped",
        instruction:
          "List work completed this week per engagement, in client-visible terms — the outcome, not the ticket title. Attach the artefact, link or demo for each.",
        expectedOutput:
          "A shipped list in client language, each entry backed by a concrete artefact.",
        required: true,
      },
      {
        title: "State next week's plan with dates",
        instruction:
          "Commit to a specific, dated set of deliverables for the coming week, sized against actual remaining capacity. Do not list more than capacity supports.",
        expectedOutput:
          "A dated deliverable list for next week that fits within measured capacity.",
        required: true,
      },
      {
        title: "Surface risks and required decisions",
        instruction:
          "Name every risk to the engagement with its likelihood, impact and mitigation, and every decision or input needed from the client with the date it is needed by.",
        expectedOutput:
          "A risk table with mitigations, and a decision list with named owners and need-by dates.",
        required: true,
      },
      {
        title: "Draft the report and route it for approval",
        instruction:
          "Write one report per engagement: Shipped, Next, Slipped (with cause), Risks, Decisions needed. Route it for human approval before it reaches the client — client-facing communication is never sent autonomously.",
        expectedOutput: "One draft report per engagement, held for human approval and not sent.",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Client status report",
        description: "One per active engagement, held for approval.",
        required: true,
      },
      {
        name: "Commitment scorecard",
        description: "Prior commitments marked met / missed / moved.",
        required: true,
      },
      {
        name: "Decision requests",
        description: "Client decisions needed, with need-by dates.",
        required: false,
      },
    ],
    acceptanceCriteria: [
      "Every active engagement has exactly one report",
      "Every commitment from the previous report is explicitly scored, including misses",
      "Every slipped item states a cause, not just a new date",
      "Next week's commitments fit inside measured remaining capacity",
      "No report is sent to a client without human approval",
    ],
  },

  // ── CMO / Mercury ────────────────────────────────────────────────────────
  {
    roleId: "marketing-studio",
    slug: "cmo-weekly-content-and-pipeline-review",
    name: "Weekly content and pipeline review",
    category: "growth",
    summary:
      "Close the loop between content shipped and pipeline created. Scores last week's campaigns against their stated hypothesis, kills what failed its criterion, and commits the next week's content against the gaps in the funnel.",
    defaultPriority: "normal",
    estimatedMinutes: 120,
    tags: ["growth", "content", "pipeline", "weekly"],
    suggestedSchedule: weekly(4, "10:00", 1_440),
    inputs: [
      {
        name: "Funnel KPIs",
        description: "`agency.ops.funnels.overview` and recorded KPI history.",
        required: true,
      },
      {
        name: "Pipeline",
        description: "`agency.ops.pipeline.list` — deals by stage with age.",
        required: true,
      },
      {
        name: "Published content inventory",
        description: "What shipped since the last review.",
        required: true,
      },
      {
        name: "Active campaign hypotheses",
        description: "Each with its declared kill criterion.",
        required: true,
      },
    ],
    steps: [
      {
        title: "Pull the funnel and pipeline numbers",
        instruction:
          "Record volume and conversion rate at every funnel stage for the last full week, plus the prior week for comparison. Record pipeline by stage, deal age and total qualified value.",
        expectedOutput:
          "A stage-by-stage funnel table with week-over-week deltas, and pipeline by stage with ageing.",
        toolHint: "agency.ops.funnels.overview, agency.ops.pipeline.list",
        required: true,
      },
      {
        title: "Score each live campaign against its hypothesis",
        instruction:
          "For every running campaign, restate its hypothesis and kill criterion, then mark it winning, inconclusive or failed against the actual numbers. A campaign with no measurable hypothesis is failed by definition and is stopped.",
        expectedOutput:
          "Every campaign labelled winning / inconclusive / failed with the number that decided it.",
        required: true,
      },
      {
        title: "Kill, scale or hold",
        instruction:
          "Stop every campaign that hit its kill criterion. Propose a budget increase for winners, with the expected marginal cost per qualified opportunity. Leave inconclusive campaigns running only if they can reach significance within one more week.",
        expectedOutput:
          "An explicit kill / scale / hold decision per campaign, with the reason and any spend change.",
        required: true,
      },
      {
        title: "Audit content performance",
        instruction:
          "For each piece published since the last review, record traffic, conversion and any pipeline attributed. Identify the single best and single worst performer and state, in one sentence each, why.",
        expectedOutput:
          "Per-asset performance figures, plus a named best and worst performer with a stated cause.",
        required: true,
      },
      {
        title: "Find the binding funnel constraint",
        instruction:
          "Identify the stage with the worst conversion relative to its benchmark. That stage — and only that stage — sets next week's content priority.",
        expectedOutput: "One named constraint stage with the evidence that it is the binding one.",
        required: true,
      },
      {
        title: "Commit next week's content plan",
        instruction:
          "Produce a dated content plan aimed at the constraint stage. Each item carries a format, an owner, a publish date, a measurable hypothesis and a kill criterion. Anything without a hypothesis is not scheduled.",
        expectedOutput:
          "A dated plan where every item has an owner, a hypothesis and a kill criterion.",
        required: true,
      },
      {
        title: "Record the scorecard",
        instruction:
          "Record this week's KPI values so the next review can diff against them, and file the scorecard to job memory.",
        expectedOutput: "KPI values recorded and the scorecard filed and retrievable.",
        toolHint: "agency.ops.funnels.kpi.record, agency.ops.employee.memory.upsert",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Campaign scorecard",
        description: "Every campaign scored with a kill/scale/hold decision.",
        required: true,
      },
      {
        name: "Content plan",
        description: "Dated, owned, each item with a hypothesis and kill criterion.",
        required: true,
      },
      {
        name: "Constraint analysis",
        description: "The binding funnel stage and its evidence.",
        required: true,
      },
    ],
    acceptanceCriteria: [
      "Every live campaign has a kill / scale / hold decision backed by a number",
      "No campaign continues past its own stated kill criterion",
      "Exactly one binding funnel constraint is named, with evidence",
      "Every planned content item has an owner, a date, a hypothesis and a kill criterion",
      "This week's KPI values are recorded so the next review can diff against them",
    ],
  },

  // ── Development Head / Vega ──────────────────────────────────────────────
  {
    roleId: "development-head",
    slug: "dev-head-code-review-and-dependency-health-sweep",
    name: "Code review and dependency health sweep",
    category: "engineering",
    summary:
      "Hold the engineering quality bar: clear the review queue, check the health of the dependency and build surface, and root-cause anything that escaped to production since the last sweep.",
    defaultPriority: "high",
    estimatedMinutes: 120,
    tags: ["engineering", "code-review", "dependencies", "quality", "weekly"],
    suggestedSchedule: weekly(2, "09:00", 1_440),
    inputs: [
      {
        name: "Open review queue",
        description: "Work items in `review`, plus open pull requests.",
        required: true,
      },
      {
        name: "Dependency manifest and lockfile",
        description: "Current versions and advisories.",
        required: true,
      },
      {
        name: "Build and test results",
        description: "Latest CI run, including timings.",
        required: true,
      },
      {
        name: "Incidents since last sweep",
        description: "Production defects and rollbacks.",
        required: false,
      },
    ],
    steps: [
      {
        title: "Clear the review queue oldest first",
        instruction:
          "Review every item awaiting review, oldest first. For each, check: acceptance criteria met, tests present and meaningful, no unrelated changes, no secret or credential added, error paths handled. Approve or return with specific, actionable comments — never a bare rejection.",
        expectedOutput:
          "Every queued review item either approved or returned with specific, actionable comments. Queue empty or every remainder explained.",
        toolHint: "agency.ops.employee.inbox.list (status review)",
        required: true,
      },
      {
        title: "Record review turnaround",
        instruction:
          "Measure the age of each item at review time. Anything that waited more than 24 hours is recorded with the reason it waited.",
        expectedOutput:
          "Review turnaround figures with an explicit reason for every item over 24 hours.",
        required: true,
      },
      {
        title: "Check the build and test surface",
        instruction:
          "Confirm the build is green and the test suite passes. Record suite duration and flagged flaky tests. A red build or a knowingly-skipped test is raised as urgent work immediately, not noted for later.",
        expectedOutput:
          "Build and test status recorded, with urgent work raised for any red build or skipped test.",
        required: true,
      },
      {
        title: "Sweep dependency health",
        instruction:
          "List direct dependencies that are behind, and any with a published security advisory. Classify each as: security (act now), major behind (plan), minor behind (batch). Never bulk-upgrade majors in this sweep.",
        expectedOutput:
          "A classified dependency list; every security advisory has a work item raised against it.",
        required: true,
      },
      {
        title: "Root-cause escaped defects",
        instruction:
          "For each defect that reached production since the last sweep, write the root cause and the specific control that would have caught it (a test, a review check, a type, a lint rule). Raise the control as work — a defect closed without a control is not closed.",
        expectedOutput:
          "One root cause plus one concrete preventive control per escaped defect, each raised as work.",
        required: true,
      },
      {
        title: "Publish the engineering health note",
        instruction:
          "Publish a note covering: review turnaround, build and test status, dependency risk, escaped defects and their controls, and the single biggest architectural risk right now.",
        expectedOutput:
          "A filed health note covering all five areas, naming one biggest architectural risk.",
        toolHint: "agency.ops.employee.memory.upsert (namespace `engineering-health`)",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Cleared review queue",
        description: "Every item approved or returned with actionable comments.",
        required: true,
      },
      {
        name: "Dependency risk list",
        description: "Classified, with work raised for every advisory.",
        required: true,
      },
      {
        name: "Engineering health note",
        description: "Review, build, dependency, defect and architecture risk.",
        required: true,
      },
    ],
    acceptanceCriteria: [
      "No review item is left untouched without a stated reason",
      "Every returned review carries specific, actionable comments",
      "Every security advisory has a work item raised against it",
      "Every escaped defect has a root cause AND a preventive control raised as work",
      "A red build or a skipped test was raised as urgent, not deferred",
    ],
  },

  // ── Back End Developer / Automation — Dev ────────────────────────────────
  {
    roleId: "coder",
    slug: "backend-automation-health-check",
    name: "Backend and automation health check",
    category: "engineering",
    summary:
      "Daily verification that the services and scheduled automations the agency depends on actually ran and actually worked. Failures become work items the same day; silent jobs are treated as failures.",
    defaultPriority: "high",
    estimatedMinutes: 45,
    tags: ["engineering", "automation", "reliability", "daily"],
    suggestedSchedule: daily("06:00", 480),
    inputs: [
      {
        name: "Scheduled job inventory",
        description: "Every cron job and its last run status.",
        required: true,
      },
      {
        name: "Integration and connection status",
        description: "`agency.ops.funnels.connection.check` and equivalents.",
        required: true,
      },
      {
        name: "Database integrity report",
        description: "`agency.ops.relations.integrity`.",
        required: true,
      },
      { name: "Yesterday's health record", description: "For trend comparison.", required: false },
    ],
    steps: [
      {
        title: "Verify every scheduled job ran",
        instruction:
          "For each enabled job, confirm it ran within its expected window and record its last status and duration. A job that produced no run record at all is treated as FAILED, not as healthy — silence is the most dangerous failure mode here.",
        expectedOutput:
          "Per-job last run time, status and duration, with every silent job explicitly marked failed.",
        required: true,
      },
      {
        title: "Check integrations and credentials",
        instruction:
          "Run the connection check for every configured external integration. Record failures, authentication errors and anything approaching a rate limit or a credential expiry.",
        expectedOutput:
          "A pass/fail line per integration, with expiring credentials and near-limit quotas named.",
        toolHint: "agency.ops.funnels.connection.check",
        required: true,
      },
      {
        title: "Check database integrity and growth",
        instruction:
          "Run the referential integrity check and record orphaned rows. Record the database file size and compare against the previous run; flag any single-day growth above 10%.",
        expectedOutput:
          "Integrity result, orphan counts, and database size with day-over-day growth percentage.",
        toolHint: "agency.ops.relations.integrity",
        required: true,
      },
      {
        title: "Confirm the backup is real",
        instruction:
          "Confirm a current backup exists and verify it — presence is not verification. An unverified or missing backup is raised as urgent work immediately.",
        expectedOutput:
          "A verified backup with its timestamp, or urgent work raised if verification failed.",
        toolHint: "agency.ops.database.backup.ensure, agency.ops.database.backup.verify",
        required: true,
      },
      {
        title: "Raise work for every failure",
        instruction:
          "Create one work item per distinct failure with the error, the affected surface and the blast radius. Group repeats of the same root cause into a single item rather than filing duplicates.",
        expectedOutput:
          "One work item per distinct root cause, each stating the error and its blast radius.",
        toolHint: "agency.ops.employee.work-item.create",
        required: true,
      },
      {
        title: "Propose one automation",
        instruction:
          "Name one manual or repeated step observed in the last day that should be automated, with the estimated time it would return per week. Skip only if nothing manual occurred, and say so explicitly.",
        expectedOutput:
          "One named automation candidate with an estimated weekly time saving, or an explicit 'none observed'.",
        required: false,
      },
      {
        title: "File the health record",
        instruction:
          "File a health record with job statuses, integration statuses, integrity and growth figures, backup verification and the failures raised, so tomorrow's run can diff against it.",
        expectedOutput: "A filed, retrievable health record covering every check above.",
        toolHint: "agency.ops.employee.memory.upsert (namespace `automation-health`)",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Health record",
        description: "Job, integration, integrity, growth and backup status.",
        required: true,
      },
      { name: "Failure work items", description: "One per distinct root cause.", required: true },
      {
        name: "Automation candidate",
        description: "One proposed automation with its weekly time saving.",
        required: false,
      },
    ],
    acceptanceCriteria: [
      "Every enabled scheduled job has an explicit status; a silent job counts as failed",
      "Every integration has a pass/fail result recorded",
      "A backup exists and was verified, or urgent work was raised",
      "Every distinct failure has exactly one work item — no duplicates for one root cause",
      "The health record is filed so the next run can diff against it",
    ],
  },

  // ── Front End Developer / Wren ───────────────────────────────────────────
  {
    roleId: "web-builder",
    slug: "frontend-release-readiness-check",
    name: "Front end release readiness check",
    category: "engineering",
    summary:
      "The gate every interface change passes before it is called done: acceptance criteria, accessibility, Core Web Vitals, cross-viewport behaviour and design-system consistency. A failed gate blocks the release rather than being logged as a follow-up.",
    defaultPriority: "normal",
    estimatedMinutes: 90,
    tags: ["engineering", "frontend", "accessibility", "performance", "weekly"],
    suggestedSchedule: weekly(3, "09:00", 1_440),
    inputs: [
      {
        name: "Interface changes since last check",
        description: "Front end work items completed or in review.",
        required: true,
      },
      {
        name: "Acceptance criteria",
        description: "From the originating brief or work item.",
        required: true,
      },
      {
        name: "Previous vitals baseline",
        description: "For regression comparison.",
        required: false,
      },
    ],
    steps: [
      {
        title: "Check every change against its acceptance criteria",
        instruction:
          "For each interface change, walk its acceptance criteria one by one and mark each met or not met with the evidence. A criterion that cannot be evidenced counts as not met.",
        expectedOutput:
          "A per-criterion met/not-met table with evidence; unevidenced criteria marked not met.",
        required: true,
      },
      {
        title: "Run the accessibility pass",
        instruction:
          "Check WCAG AA: colour contrast, keyboard reachability and visible focus for every interactive element, form labels, image alternatives, heading order, and correct landmark and ARIA usage. Record each violation with the element and the rule it breaks.",
        expectedOutput:
          "A violation list naming the element and the specific WCAG rule, or an explicit clean result.",
        required: true,
      },
      {
        title: "Measure Core Web Vitals",
        instruction:
          "Measure LCP, CLS and INP for each changed view and compare against the previous baseline. A regression past threshold blocks the release; it is not a follow-up ticket.",
        expectedOutput:
          "LCP, CLS and INP per changed view with deltas against baseline, and a pass/block verdict.",
        required: true,
      },
      {
        title: "Verify responsive and cross-browser behaviour",
        instruction:
          "Check each changed view at mobile, tablet and desktop widths, and confirm no horizontal overflow, no truncated content and no unreachable control. Confirm behaviour in at least two rendering engines.",
        expectedOutput:
          "A pass/fail per viewport and per engine, with a screenshot or description of every failure.",
        required: true,
      },
      {
        title: "Check design-system consistency",
        instruction:
          "Confirm new UI reuses existing components, tokens and spacing rather than introducing one-offs. Every deviation must be either justified in writing or refactored onto the system before release.",
        expectedOutput: "A list of deviations, each either justified in writing or resolved.",
        required: true,
      },
      {
        title: "Record the verdict",
        instruction:
          "Publish a per-change verdict of ready or blocked. For anything blocked, name the exact failing gate and what must change. Update the vitals baseline only for changes that passed.",
        expectedOutput:
          "A ready/blocked verdict per change, each blocked one naming its failing gate; baseline updated for passes only.",
        toolHint: "agency.ops.employee.memory.upsert (namespace `frontend-release`)",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Release readiness verdict",
        description: "Ready or blocked, per change.",
        required: true,
      },
      {
        name: "Accessibility violation list",
        description: "Element plus the WCAG rule broken.",
        required: true,
      },
      {
        name: "Vitals report",
        description: "LCP, CLS, INP with deltas against baseline.",
        required: true,
      },
    ],
    acceptanceCriteria: [
      "Every acceptance criterion is marked met or not met with evidence",
      "No change is marked ready with an outstanding WCAG AA violation",
      "No change is marked ready with a Core Web Vitals regression past threshold",
      "Every changed view was checked at mobile, tablet and desktop widths",
      "Every design-system deviation is either justified in writing or resolved",
    ],
  },

  // ── CEO / Atlas ──────────────────────────────────────────────────────────
  {
    roleId: "ceo",
    slug: "ceo-weekly-operating-review",
    name: "Weekly operating review",
    category: "leadership",
    summary:
      "The weekly decision-forcing review: measure the agency against its quarterly plan, protect margin and client health, and kill or refund work that no longer earns its capacity. Ends with decisions and owners, never with a discussion.",
    defaultPriority: "high",
    estimatedMinutes: 120,
    tags: ["leadership", "operating-review", "metrics", "weekly"],
    suggestedSchedule: weekly(1, "08:00", 1_440),
    inputs: [
      { name: "Agency dashboard", description: "`agency.ops.dashboard`.", required: true },
      {
        name: "Finance summary",
        description: "`agency.ops.finance.summary` and revenue summary.",
        required: true,
      },
      {
        name: "Function reports",
        description: "This week's delivery, growth and engineering notes.",
        required: true,
      },
      {
        name: "Quarterly plan",
        description: "Goals with their current attainment.",
        required: true,
      },
      {
        name: "Last week's decisions",
        description: "For follow-through checking.",
        required: false,
      },
    ],
    steps: [
      {
        title: "Check last week's decisions were executed",
        instruction:
          "Take every decision recorded in the previous review and mark it done, in progress or not started. A decision not started two weeks running is either re-owned with a date or explicitly abandoned — it is never carried silently.",
        expectedOutput:
          "Every prior decision marked done / in progress / not started, with re-ownership or abandonment for repeat misses.",
        required: true,
      },
      {
        title: "Measure against the quarterly plan",
        instruction:
          "For each quarterly goal, record the target, the current value and the pace needed to hit it. Mark each on track, at risk or off track using the required pace, not the sentiment.",
        expectedOutput:
          "A per-goal table of target, current, required pace and a pace-derived status.",
        required: true,
      },
      {
        title: "Review money",
        instruction:
          "Record revenue for the period, gross margin, outstanding receivables with ageing, and cash runway in months. Name any client above 25% of revenue as a concentration risk.",
        expectedOutput:
          "Revenue, gross margin, aged receivables and runway in months, with concentration risks named.",
        toolHint: "agency.ops.finance.summary, agency.ops.revenue.summary",
        required: true,
      },
      {
        title: "Review client health",
        instruction:
          "For every active client, record delivery status, unresolved escalations and payment status. Rank them and name the three most at risk of churning, with the specific reason for each.",
        expectedOutput:
          "A ranked client health list naming the top three churn risks with a specific reason each.",
        required: true,
      },
      {
        title: "Review capacity against committed work",
        instruction:
          "Compare total committed work against actual capacity for the next four weeks. If commitments exceed capacity, decide now what is cut, moved or resourced — do not leave the overcommitment standing.",
        expectedOutput:
          "A four-week capacity-versus-commitment figure, and an explicit cut / move / resource decision for any overcommitment.",
        required: true,
      },
      {
        title: "Kill what no longer earns its capacity",
        instruction:
          "Identify every workstream, campaign or engagement whose return no longer justifies the capacity it consumes. Stop it, or state explicitly why it continues and what would have to be true next week for it to survive.",
        expectedOutput:
          "A stop or continue decision per underperforming workstream, with a stated survival condition for anything continuing.",
        required: true,
      },
      {
        title: "Record decisions with owners and dates",
        instruction:
          "Close with a decision list. Every decision has one named owner and a date. Anything without an owner and a date is not a decision and is struck from the list.",
        expectedOutput:
          "A decision list where every entry has exactly one owner and a date, filed for next week's follow-through check.",
        toolHint: "agency.ops.employee.memory.upsert (namespace `operating-review`)",
        required: true,
      },
    ],
    outputs: [
      {
        name: "Operating review record",
        description: "Plan attainment, money, client health, capacity.",
        required: true,
      },
      {
        name: "Decision list",
        description: "Every decision with one owner and a date.",
        required: true,
      },
      {
        name: "Churn risk list",
        description: "Top three at-risk clients with reasons.",
        required: true,
      },
    ],
    acceptanceCriteria: [
      "Every decision from the previous review is explicitly scored",
      "Every quarterly goal has a status derived from required pace, not sentiment",
      "Gross margin, aged receivables and runway are all recorded",
      "Any overcommitment against capacity has an explicit cut / move / resource decision",
      "Every decision has exactly one named owner and a date",
    ],
  },
];

export type SeedSopsResult = {
  /** SOPs that did not exist and were created. */
  created: number;
  /** Already at the current seed version — left completely untouched. */
  existing: number;
  /** Behind the current seed version and reconciled onto it, once. */
  adopted: number;
  /** Slug taken over by an operator, or role not present — deliberately skipped. */
  skipped: number;
};

/**
 * Idempotently provision the agency's starter SOPs.
 *
 * `workerIdByRoleId` maps a seed role (`pm`, `ceo`, …) to the worker id that
 * owns it — normally derived from `agentId`, so adopted pre-v2 workers keep
 * their original id. A role with no worker on this agency is skipped rather
 * than seeded ownerless.
 *
 * Contract: safe to call on every request. A second call with no intervening
 * changes performs no writes at all.
 */
export function seedAgencySops(
  store: WorkforceSopStore,
  agencyId: string,
  workerIdByRoleId: Map<string, string>,
): SeedSopsResult {
  const result: SeedSopsResult = { created: 0, existing: 0, adopted: 0, skipped: 0 };

  for (const seed of SOP_SEEDS) {
    const ownerWorkerId = workerIdByRoleId.get(seed.roleId);
    if (!ownerWorkerId) {
      result.skipped += 1;
      continue;
    }

    const definition = {
      name: seed.name,
      summary: seed.summary,
      ownerWorkerId,
      ownerRoleId: seed.roleId,
      category: seed.category,
      status: "active" as const,
      steps: seed.steps,
      inputs: seed.inputs,
      outputs: seed.outputs,
      acceptanceCriteria: seed.acceptanceCriteria,
      tags: seed.tags,
      defaultPriority: seed.defaultPriority,
      estimatedMinutes: seed.estimatedMinutes,
      seedKey: seed.slug,
      seedVersion: SOP_SEED_VERSION,
    };

    const existing = store.getSopBySlug(agencyId, seed.slug);
    if (!existing) {
      store.createSop(agencyId, { ...definition, slug: seed.slug, source: "seed" });
      result.created += 1;
      continue;
    }
    // The operator has taken this slug over. It is theirs; never rewrite it.
    if (existing.source !== "seed") {
      result.skipped += 1;
      continue;
    }
    if (existing.seedVersion >= SOP_SEED_VERSION) {
      result.existing += 1;
      continue;
    }
    // One-time reconciliation onto the current definition. `updateSop` is a
    // genuine no-op when nothing differs, so this cannot churn the row.
    store.updateSop(agencyId, existing.id, definition);
    result.adopted += 1;
  }

  return result;
}

/** The suggested cadence for a seeded SOP slug, for the UI's one-click attach. */
export function suggestedScheduleFor(slug: string): SopSeedSchedule | null {
  return SOP_SEEDS.find((seed) => seed.slug === slug)?.suggestedSchedule ?? null;
}

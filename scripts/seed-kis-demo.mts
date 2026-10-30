/**
 * Seed a coherent, realistic demo dataset for "Kingly Kreationz" into the LIVE
 * KIS Phase 1 object stores, then wire the typed relationship graph.
 *
 * Usage: node --import tsx scripts/seed-kis-demo.mts
 *
 * Why in-process: every store below resolves its SQLite file under the runtime
 * state dir (~/.infinibot) — the SAME files the running gateway reads — so the
 * /opportunities, /ceo, /ops, /people, /decisions, /risks and /commitments views
 * pick the data up on the next refresh. No gateway restart is required.
 *
 * Idempotent: every KIS record is created with a deterministic `clientRequestId`
 * (which the stores use as the row id and no-op on repeat), clients are matched
 * by name, kanban projects/tasks are matched by id/title, and relation edges are
 * de-duplicated by (fromType, fromId, edge, toType, toId). Re-running the script
 * therefore converges rather than duplicating.
 *
 * Data quality: this is seeded demonstration data. Every record is written as
 * "OperationsEstimated" or "FounderReported" (§35) — never "Verified".
 */

import { resolveStateDir } from "../src/config/paths.js";
import { getAgencyOperationsStore } from "../src/agency-operations/store.js";
import { DEFAULT_AGENCY_ID } from "../src/agency-operations/types.js";
import { getKanbanStore } from "../src/tasks/store.js";
import { getOpportunityStore } from "../src/opportunity/store.js";
import { getProductStore } from "../src/product/store.js";
import { getDecisionStore } from "../src/decision/store.js";
import { getRiskStore } from "../src/risk/store.js";
import { getCommitmentStore } from "../src/commitment/store.js";
import { getPersonStore } from "../src/person/store.js";
import { getRelationsStore } from "../src/relations/store.js";
import type { KanbanProject, KanbanTask, TaskStatus } from "../src/tasks/types.js";

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

const CREATED_BY = "seed-kis-demo";
const OUT: string[] = [];

function say(line = ""): void {
  OUT.push(line);
  console.log(line);
}

const NOW = Date.now();
const DAY_MS = 86_400_000;

/** ISO YYYY-MM-DD `offset` days from now (negative = in the past). */
function day(offset: number): string {
  return new Date(NOW + offset * DAY_MS).toISOString().slice(0, 10);
}

const stateDir = resolveStateDir();

// ═══════════════════════════════════════════════════════════════════
// 0. CLIENTS (agency.db — the canonical clients store behind /clients)
// ═══════════════════════════════════════════════════════════════════

const agency = getAgencyOperationsStore(stateDir);
if (!agency.getAgency(DEFAULT_AGENCY_ID)) {
  agency.createAgency({
    id: DEFAULT_AGENCY_ID,
    name: "Kingly Kreationz",
    slug: "kingly-kreationz",
    ownerUserId: "founder",
  });
}

interface ClientSeed {
  key: string;
  name: string;
  pipelineStatus: string;
  email: string;
  notes: string;
}

const CLIENT_SEEDS: ClientSeed[] = [
  {
    key: "aurora",
    name: "Aurora Peak Adventure Park",
    pipelineStatus: "In progress",
    email: "ops@aurorapeak.demo",
    notes:
      "Regional adventure/theme park. Season-pass companion app + ride wait-time signage. Seasonal deadlines are immovable. [DEMO DATA]",
  },
  {
    key: "northlake",
    name: "Northlake Family Medical",
    pipelineStatus: "In progress",
    email: "admin@northlakefamily.demo",
    notes:
      "Three-location family practice. Patient intake automation + telehealth portal. PHI handling review still outstanding. [DEMO DATA]",
  },
  {
    key: "cobaltfox",
    name: "Cobalt Fox Digital",
    pipelineStatus: "Lead",
    email: "partners@cobaltfox.demo",
    notes:
      "Dev agency reselling the Kingly Core Platform white-label to their own client base. [DEMO DATA]",
  },
];

const clientIds: Record<string, string> = {};
let clientsCreated = 0;
for (const seed of CLIENT_SEEDS) {
  const existing = agency
    .listClients(DEFAULT_AGENCY_ID)
    .find((c) => c.name.toLowerCase() === seed.name.toLowerCase());
  if (existing) {
    clientIds[seed.key] = existing.id;
    continue;
  }
  const created = agency.createClient(
    {
      name: seed.name,
      pipelineStatus: seed.pipelineStatus,
      email: seed.email,
      billingEmail: seed.email,
      notes: seed.notes,
    },
    { agencyId: DEFAULT_AGENCY_ID },
  );
  clientIds[seed.key] = created.id;
  clientsCreated++;
}

// ═══════════════════════════════════════════════════════════════════
// 1. PEOPLE / RESOURCES (Object 9)
// ═══════════════════════════════════════════════════════════════════

const persons = getPersonStore(stateDir);

const PERSON_SEEDS = [
  {
    id: "kkz-person-marcus",
    name: "Marcus Kingly",
    relationshipType: "Founder",
    role: "Founder / CEO",
    status: "Active",
    capabilities: ["Product direction", "Sales", "Architecture review", "Pricing"],
    availability: "Full-time (fragmented — final authority on all CEO-queue items)",
    costRate: "Equity",
    accessLevel: "Owner",
    email: "marcus@kinglykreationz.demo",
    dataQuality: "FounderReported",
  },
  {
    id: "kkz-person-dana",
    name: "Dana Reyes",
    relationshipType: "Employee",
    role: "Operations Lead",
    status: "Active",
    capabilities: ["Delivery management", "Client comms", "Risk review", "Invoicing"],
    availability: "Full-time",
    costRate: "$5,200/mo",
    accessLevel: "Admin",
    email: "dana@kinglykreationz.demo",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-person-priya",
    name: "Priya Shah",
    relationshipType: "Contractor",
    role: "Full-Stack Engineer",
    status: "Active",
    capabilities: ["React Native", "Node/TypeScript", "FHIR", "Postgres"],
    availability: "30 hrs/week",
    costRate: "$95/hr",
    accessLevel: "Standard",
    email: "priya@shahbuilds.demo",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-person-theo",
    name: "Theo Lindqvist",
    relationshipType: "Contractor",
    role: "Motion / Brand Designer",
    status: "Active",
    capabilities: ["Motion graphics", "Brand systems", "Signage design", "After Effects"],
    availability: "Weekends + 10 hrs/week",
    costRate: "$70/hr",
    accessLevel: "Restricted",
    email: "theo@lindqvist.demo",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-person-sam",
    name: "Sam Okafor",
    relationshipType: "Partner",
    role: "Delivery Director, Cobalt Fox Digital",
    status: "Onboarding",
    capabilities: ["Agency delivery", "White-label rollout", "Account management"],
    availability: "Partner contact — async",
    costRate: "Revenue share (unsigned)",
    accessLevel: "Restricted",
    email: "sam@cobaltfox.demo",
    dataQuality: "FounderReported",
  },
];

const personIds: Record<string, string> = {};
for (const p of PERSON_SEEDS) {
  const rec = persons.create({
    clientRequestId: p.id,
    name: p.name,
    relationshipType: p.relationshipType,
    role: p.role,
    status: p.status,
    capabilities: p.capabilities,
    availability: p.availability,
    costRate: p.costRate,
    accessLevel: p.accessLevel,
    email: p.email,
    owner: "Marcus Kingly",
    priority: "P2",
    dataQuality: p.dataQuality,
    authorityLevel: "L0",
  });
  personIds[p.id] = rec.id;
}

// ═══════════════════════════════════════════════════════════════════
// 2. PRODUCTS (Object 5) — Built ≠ Product: status and validationStage
//    are set independently.
// ═══════════════════════════════════════════════════════════════════

const products = getProductStore(stateDir);

const PRODUCT_SEEDS = [
  {
    id: "kkz-product-core",
    name: "Kingly Core Platform",
    productType: "Core Platform",
    status: "Active",
    validationStage: "Repeat Sales",
    owner: "Marcus Kingly",
    technicalOwner: "Priya Shah",
    targetCustomer: "Regional SMBs that need a bespoke customer-facing app without an in-house dev team",
    problemSolved: "Every client build restarted from zero: auth, billing, admin, notifications.",
    valueProposition: "One hardened base; each client engagement is a configuration, not a rebuild.",
    revenueModel: "License",
    pricing: "$1,800/mo per deployment + build fee",
    priority: "P0",
    nextProductDecision: "Whether the white-label license tier gets its own SLA",
    dataQuality: "FounderReported",
  },
  {
    id: "kkz-product-parkpulse",
    name: "ParkPulse Visitor Experience",
    productType: "Vertical Product",
    status: "Development",
    validationStage: "Pilot",
    owner: "Dana Reyes",
    technicalOwner: "Priya Shah",
    targetCustomer: "Regional theme parks and attractions (200k–1M annual visitors)",
    problemSolved: "Guests have no live view of ride wait times or season-pass perks.",
    valueProposition: "Wait-time signage network + season-pass companion app on one data spine.",
    revenueModel: "Hybrid",
    pricing: "Build fee + $900/mo per park",
    priority: "P1",
    parentProductId: "kkz-product-core",
    nextProductDecision: "Signage hardware: lease vs. client-owned",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-product-clinicflow",
    name: "ClinicFlow Intake Suite",
    productType: "Vertical Product",
    status: "Development",
    validationStage: "Proof of Concept",
    owner: "Dana Reyes",
    technicalOwner: "Priya Shah",
    targetCustomer: "Independent multi-location family practices",
    problemSolved: "Paper intake and phone triage consume ~2 staff-hours per clinician per day.",
    valueProposition: "FHIR-aware digital intake that hands clean data to the existing EHR.",
    revenueModel: "Subscription",
    pricing: "$640/mo per location",
    priority: "P1",
    parentProductId: "kkz-product-core",
    nextProductDecision: "Whether PHI hosting stays in-house or moves to a BAA-covered vendor",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-product-reelengine",
    name: "Reel Engine Content Kit",
    productType: "Digital Product",
    status: "Active",
    validationStage: "Repeat Sales",
    owner: "Theo Lindqvist",
    technicalOwner: "Theo Lindqvist",
    targetCustomer: "Existing clients who need short-form launch content",
    problemSolved: "Clients launch a product with no marketing assets ready.",
    valueProposition: "Templated motion kit that turns a launch into 12 shippable reels.",
    revenueModel: "Project Fee",
    pricing: "$2,400 per kit",
    priority: "P3",
    nextProductDecision: "Retire the v1 template set",
    dataQuality: "OperationsEstimated",
  },
];

const productIds: Record<string, string> = {};
for (const p of PRODUCT_SEEDS) {
  const rec = products.create({
    clientRequestId: p.id,
    name: p.name,
    productType: p.productType,
    status: p.status,
    validationStage: p.validationStage,
    owner: p.owner,
    technicalOwner: p.technicalOwner,
    targetCustomer: p.targetCustomer,
    problemSolved: p.problemSolved,
    valueProposition: p.valueProposition,
    revenueModel: p.revenueModel,
    pricing: p.pricing,
    priority: p.priority,
    parentProductId: p.parentProductId,
    nextProductDecision: p.nextProductDecision,
    dataQuality: p.dataQuality,
    authorityLevel: "L1",
  });
  productIds[p.id] = rec.id;
}

// ═══════════════════════════════════════════════════════════════════
// 3. OPPORTUNITIES (Object 2) — across the pipeline
// ═══════════════════════════════════════════════════════════════════

const opportunities = getOpportunityStore(stateDir);

const OPPORTUNITY_SEEDS = [
  {
    id: "kkz-opp-northlake-intake",
    name: "Northlake — Patient Intake Automation",
    stage: "New",
    opportunityType: "New Client",
    owner: "Dana Reyes",
    estimatedValue: 18500,
    revenueType: "Hybrid",
    opportunityScore: 62,
    clientKey: "northlake",
    productKey: "kkz-product-clinicflow",
    problemNeed: "Front desk loses ~2 hrs/clinician/day to paper intake and phone triage.",
    proposedSolution: "ClinicFlow intake suite across all three locations, EHR hand-off via FHIR.",
    expectedCloseDate: day(38),
    nextAction: "Send discovery questionnaire to the practice manager",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(3),
    priority: "P2",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-opp-cobaltfox-license",
    name: "Cobalt Fox — White-Label Platform License",
    stage: "Qualification",
    opportunityType: "Licensing",
    owner: "Marcus Kingly",
    estimatedValue: 32000,
    revenueType: "Recurring",
    opportunityScore: 71,
    clientKey: "cobaltfox",
    productKey: "kkz-product-core",
    problemNeed: "Cobalt Fox loses bids because they have no platform of their own to resell.",
    proposedSolution: "Annual white-label license of Kingly Core with a partner support tier.",
    expectedCloseDate: day(52),
    waitingFor: "Cobalt Fox to confirm their reseller volume commitment",
    reviewDate: day(9),
    priority: "P1",
    dataQuality: "FounderReported",
  },
  {
    id: "kkz-opp-aurora-signage",
    name: "Aurora Peak — Ride Wait-Time Signage Network",
    stage: "Proposal",
    opportunityType: "Expansion",
    owner: "Dana Reyes",
    estimatedValue: 47500,
    revenueType: "Hybrid",
    opportunityScore: 84,
    clientKey: "aurora",
    productKey: "kkz-product-parkpulse",
    ceoRequired: true,
    problemNeed: "Guests queue blind; the park has no live wait-time surface anywhere on site.",
    proposedSolution: "14-panel signage network fed by ParkPulse, plus in-app live wait times.",
    expectedCloseDate: day(21),
    nextAction: "Walk the CEO through the hardware lease vs. purchase pricing split",
    nextActionOwner: "Marcus Kingly",
    nextActionDate: day(2),
    priority: "P0",
    proposalLink: "https://demo.kinglykreationz.test/proposals/aurora-signage",
    notes: "Above the $25k CEO value threshold — pricing structure needs the founder's call.",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-opp-northlake-telehealth",
    name: "Northlake — Telehealth Portal Phase 2",
    stage: "Negotiation",
    opportunityType: "Expansion",
    owner: "Dana Reyes",
    estimatedValue: 26400,
    revenueType: "Recurring",
    opportunityScore: 77,
    clientKey: "northlake",
    productKey: "kkz-product-clinicflow",
    problemNeed: "Phase 1 portal has no video visits or post-visit summaries.",
    proposedSolution: "Phase 2 adds video visits, summaries and a patient-messaging inbox.",
    expectedCloseDate: day(12),
    nextAction: "Return redlines on the BAA addendum",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(-2),
    priority: "P1",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-opp-aurora-companion",
    name: "Aurora Peak — Season Pass Companion App",
    stage: "Won",
    opportunityType: "New Client",
    owner: "Marcus Kingly",
    estimatedValue: 84000,
    revenueType: "Hybrid",
    opportunityScore: 91,
    clientKey: "aurora",
    productKey: "kkz-product-parkpulse",
    problemNeed: "Season-pass holders had no digital home: no perks, no pass, no park map.",
    proposedSolution: "Companion app on Kingly Core with ParkPulse pass, perks and live map.",
    expectedCloseDate: day(-24),
    status: "Won",
    priority: "P0",
    notes: "Signed. Delivery runs against the immovable season-open date.",
    dataQuality: "FounderReported",
  },
];

const opportunityIds: Record<string, string> = {};
for (const o of OPPORTUNITY_SEEDS) {
  const rec = opportunities.create({
    clientRequestId: o.id,
    name: o.name,
    stage: o.stage,
    status: o.status ?? o.stage,
    opportunityType: o.opportunityType,
    owner: o.owner,
    ceoRequired: o.ceoRequired ?? false,
    estimatedValue: o.estimatedValue,
    revenueType: o.revenueType,
    opportunityScore: o.opportunityScore,
    problemNeed: o.problemNeed,
    proposedSolution: o.proposedSolution,
    expectedCloseDate: o.expectedCloseDate,
    nextAction: o.nextAction,
    nextActionOwner: o.nextActionOwner,
    nextActionDate: o.nextActionDate,
    waitingFor: o.waitingFor,
    reviewDate: o.reviewDate,
    clientId: clientIds[o.clientKey],
    productId: productIds[o.productKey],
    proposalLink: o.proposalLink,
    notes: o.notes,
    priority: o.priority,
    dataQuality: o.dataQuality,
    authorityLevel: "L1",
  });
  opportunityIds[o.id] = rec.id;
}

// ═══════════════════════════════════════════════════════════════════
// 4. PROJECTS (kanban store — the projects the ops agents read)
// ═══════════════════════════════════════════════════════════════════

const kanban = getKanbanStore(stateDir);
const existingProjects = await kanban.getProjects();
const existingProjectIds = new Set(existingProjects.map((p) => p.id));

interface ProjectSeed {
  id: string;
  name: string;
  description: string;
  status: KanbanProject["status"];
  priority: KanbanProject["priority"];
  dueDate?: string;
  progress: number;
  clientKey: string;
  opportunityKey: string;
  productKey: string;
}

const PROJECT_SEEDS: ProjectSeed[] = [
  {
    id: "kkz-proj-aurora-companion",
    name: "Aurora Peak — Season Pass Companion App",
    description:
      "[DEMO] Companion app delivery for Aurora Peak Adventure Park. Season-pass wallet, perks, live park map. Hard deadline: season open.",
    status: "In progress",
    priority: "Immediate",
    dueDate: day(57),
    progress: 45,
    clientKey: "aurora",
    opportunityKey: "kkz-opp-aurora-companion",
    productKey: "kkz-product-parkpulse",
  },
  {
    id: "kkz-proj-northlake-telehealth",
    name: "Northlake — Telehealth Portal Phase 2",
    description:
      "[DEMO] Video visits, post-visit summaries and patient messaging on top of the Phase 1 portal. Gated on the signed BAA.",
    status: "Awaiting Client",
    priority: "High",
    dueDate: day(42),
    progress: 15,
    clientKey: "northlake",
    opportunityKey: "kkz-opp-northlake-telehealth",
    productKey: "kkz-product-clinicflow",
  },
  {
    id: "kkz-proj-cobaltfox-whitelabel",
    name: "Cobalt Fox — White-Label Platform Rollout",
    description:
      "[DEMO] BLOCKED — build proceeding while the license agreement is unsigned. Do not ship the partner tenant until legal clears.",
    status: "Paused",
    priority: "High",
    progress: 20,
    clientKey: "cobaltfox",
    opportunityKey: "kkz-opp-cobaltfox-license",
    productKey: "kkz-product-core",
  },
  {
    id: "kkz-proj-parkpulse-signage",
    name: "ParkPulse Pilot — Aurora Peak Ride Signage",
    description:
      "[DEMO] 14-panel wait-time signage pilot. Proves the ParkPulse data spine outside the app.",
    status: "In progress",
    priority: "High",
    dueDate: day(30),
    progress: 25,
    clientKey: "aurora",
    opportunityKey: "kkz-opp-aurora-signage",
    productKey: "kkz-product-parkpulse",
  },
];

let projectsCreated = 0;
for (const p of PROJECT_SEEDS) {
  if (existingProjectIds.has(p.id)) continue;
  await kanban.createProject({
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    priority: p.priority,
    dueDate: p.dueDate,
    progress: p.progress,
    type: ["Client Work"],
    color: "#d4af37",
  });
  projectsCreated++;
}

// ═══════════════════════════════════════════════════════════════════
// 5. TASKS (kanban store) — deliberately includes overdue tasks and
//    two owner-less tasks so the §20 Operations Monitor lights up.
// ═══════════════════════════════════════════════════════════════════

interface TaskSeed {
  key: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  personKey?: string;
  dueDate?: string;
  priorityLevel: KanbanTask["priorityLevel"];
}

const TASK_SEEDS: TaskSeed[] = [
  {
    key: "kkz-task-aurora-wallet",
    projectId: "kkz-proj-aurora-companion",
    title: "Season-pass wallet: offline pass rendering",
    description: "[DEMO] Passes must scan at the gate with no signal. Cache + signed QR refresh.",
    status: "in_progress",
    assignee: "Priya Shah",
    personKey: "kkz-person-priya",
    dueDate: day(-4), // OVERDUE
    priorityLevel: "Immediate",
  },
  {
    key: "kkz-task-aurora-map",
    projectId: "kkz-proj-aurora-companion",
    title: "Live park map — ride status overlay",
    description: "[DEMO] Overlay live ride status onto the park map tiles.",
    status: "todo",
    assignee: "Priya Shah",
    personKey: "kkz-person-priya",
    dueDate: day(11),
    priorityLevel: "High",
  },
  {
    key: "kkz-task-aurora-brand",
    projectId: "kkz-proj-aurora-companion",
    title: "Onboarding motion sequence + app store assets",
    description: "[DEMO] Three-screen onboarding animation and the store listing art.",
    status: "todo",
    // NO OWNER — trips the §27 missing-owner exception
    dueDate: day(18),
    priorityLevel: "Medium",
  },
  {
    key: "kkz-task-aurora-loadtest",
    projectId: "kkz-proj-aurora-companion",
    title: "Season-open load test (12k concurrent pass scans)",
    description: "[DEMO] Prove the gate-scan path holds at season-open peak.",
    status: "in_progress",
    assignee: "Dana Reyes",
    personKey: "kkz-person-dana",
    // NO DUE DATE on an in-progress task — trips the missing-deadline exception
    priorityLevel: "High",
  },
  {
    key: "kkz-task-northlake-baa",
    projectId: "kkz-proj-northlake-telehealth",
    title: "Return BAA addendum redlines to Northlake counsel",
    description: "[DEMO] Phase 2 cannot start until the BAA addendum is executed.",
    status: "todo",
    assignee: "Dana Reyes",
    personKey: "kkz-person-dana",
    dueDate: day(-6), // OVERDUE
    priorityLevel: "Immediate",
  },
  {
    key: "kkz-task-northlake-fhir",
    projectId: "kkz-proj-northlake-telehealth",
    title: "FHIR summary export for post-visit notes",
    description: "[DEMO] Map post-visit summaries onto the practice's existing FHIR endpoints.",
    status: "backlog",
    assignee: "Priya Shah",
    personKey: "kkz-person-priya",
    dueDate: day(34),
    priorityLevel: "High",
  },
  {
    key: "kkz-task-cobaltfox-tenant",
    projectId: "kkz-proj-cobaltfox-whitelabel",
    title: "Partner tenant provisioning + theming pipeline",
    description: "[DEMO] HOLD until the license agreement is signed — do not provision production.",
    status: "todo",
    assignee: "Priya Shah",
    personKey: "kkz-person-priya",
    dueDate: day(25),
    priorityLevel: "Medium",
  },
  {
    key: "kkz-task-cobaltfox-terms",
    projectId: "kkz-proj-cobaltfox-whitelabel",
    title: "Draft reseller support-tier SLA",
    description: "[DEMO] Support obligations under the white-label tier are still undefined.",
    status: "todo",
    // NO OWNER — trips the §27 missing-owner exception
    dueDate: day(-1), // OVERDUE and unowned
    priorityLevel: "High",
  },
  {
    key: "kkz-task-signage-hardware",
    projectId: "kkz-proj-parkpulse-signage",
    title: "Spec the 14-panel hardware bill of materials",
    description: "[DEMO] Lease vs. client-owned changes the BOM and the margin.",
    status: "in_progress",
    assignee: "Dana Reyes",
    personKey: "kkz-person-dana",
    dueDate: day(6),
    priorityLevel: "High",
  },
  {
    key: "kkz-task-signage-layout",
    projectId: "kkz-proj-parkpulse-signage",
    title: "Signage layout system + legibility pass at 20ft",
    description: "[DEMO] Panel typography has to read at distance in direct sun.",
    status: "todo",
    assignee: "Theo Lindqvist",
    personKey: "kkz-person-theo",
    dueDate: day(14),
    priorityLevel: "Medium",
  },
  {
    key: "kkz-task-reelengine-retire",
    projectId: "kkz-proj-aurora-companion",
    title: "Migrate Aurora launch reels off the v1 template set",
    description: "[DEMO] v1 templates are slated for retirement; move the launch kit to v2.",
    status: "backlog",
    assignee: "Theo Lindqvist",
    personKey: "kkz-person-theo",
    dueDate: day(28),
    priorityLevel: "Low",
  },
];

const existingTasks = await kanban.getTasks();
const existingTaskKey = new Map(existingTasks.map((t) => [`${t.projectId}::${t.title}`, t.id]));

const taskIds: Record<string, string> = {};
let tasksCreated = 0;
for (const t of TASK_SEEDS) {
  const dedupeKey = `${t.projectId}::${t.title}`;
  const already = existingTaskKey.get(dedupeKey);
  if (already) {
    taskIds[t.key] = already;
    continue;
  }
  const rec = await kanban.createTask({
    projectId: t.projectId,
    title: t.title,
    description: t.description,
    status: t.status,
    assignee: t.assignee,
    dueDate: t.dueDate,
    priorityLevel: t.priorityLevel,
    tags: ["kis-demo"],
  });
  taskIds[t.key] = rec.id;
  tasksCreated++;
}

// ═══════════════════════════════════════════════════════════════════
// 6. DECISIONS (Object 6) — the CEO Queue, in §17 CEO Request Format
// ═══════════════════════════════════════════════════════════════════

const decisions = getDecisionStore(stateDir);

const DECISION_SEEDS = [
  {
    id: "kkz-dec-companion-stack",
    title: "Season Pass companion app: React Native vs. PWA",
    decisionType: "Technical",
    status: "CEO Review",
    owner: "Marcus Kingly",
    requestedBy: "Priya Shah",
    priority: "P0",
    ceoTriggers: ["technical_architecture"],
    financialImpact: 14000,
    decisionRequired:
      "Do we ship the Aurora Peak companion app as a React Native binary in both app stores, or as an installable PWA?",
    whyNow:
      "Gate-scan hardware integration starts in 6 days and the two paths need different scan libraries. Delaying past that means rewriting the wallet layer.",
    options:
      "A) React Native — native scan reliability, offline passes, ~3 weeks store review risk, +$14k build.\nB) PWA — ships immediately, no store gate, offline pass rendering is fragile on iOS.\nC) PWA now, React Native for season two — two codebases for one season.",
    recommendation:
      "Option A. Gate-scan reliability at season open is the contract's success criterion; the store-review risk is manageable if we submit within 10 days.",
    decisionDeadline: day(4),
    impactIfDelayed:
      "Slips the gate-scan integration window; season-open date is immovable, so the slack comes out of QA.",
    clientKey: "aurora",
    projectId: "kkz-proj-aurora-companion",
    productKey: "kkz-product-parkpulse",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-dec-signage-pricing",
    title: "Signage network pricing: hardware lease vs. client purchase",
    decisionType: "Pricing",
    status: "CEO Review",
    owner: "Marcus Kingly",
    requestedBy: "Dana Reyes",
    priority: "P0",
    ceoTriggers: ["material_pricing_exception", "opportunity_above_value"],
    financialImpact: 47500,
    decisionRequired:
      "Do we lease the 14 signage panels to Aurora Peak on a monthly rate, or bill them as a client-owned capital purchase?",
    whyNow:
      "The proposal goes out in 48 hours and the pricing structure changes the contract shape, not just the number.",
    options:
      "A) Lease at $900/mo per park incl. hardware — recurring, we carry $19k capital.\nB) Client purchase + $400/mo software — they carry capital, our margin lands up front.\nC) Hybrid: they buy panels, we lease the controllers.",
    recommendation:
      "Option B. We do not have $19k of capital to park in one client's hardware while the Cobalt Fox license is unsigned.",
    decisionDeadline: day(2),
    impactIfDelayed:
      "Proposal ships without pricing or slips a week; Aurora's procurement window closes at month end.",
    clientKey: "aurora",
    opportunityKey: "kkz-opp-aurora-signage",
    projectId: "kkz-proj-parkpulse-signage",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-dec-parkpulse-ip",
    title: "Who owns the ParkPulse signage IP under the Aurora contract",
    decisionType: "Legal",
    status: "Ready for Decision",
    owner: "Marcus Kingly",
    requestedBy: "Dana Reyes",
    priority: "P1",
    ceoTriggers: ["ip_ownership"],
    financialImpact: 47500,
    decisionRequired:
      "Does Aurora Peak get an exclusive licence to the ParkPulse signage layer, or a non-exclusive one that lets us resell to other parks?",
    whyNow:
      "Aurora's counsel asked for exclusivity in the draft. If we concede it, ParkPulse stops being a product and becomes one client's custom build.",
    options:
      "A) Non-exclusive licence — ParkPulse stays a resellable vertical product.\nB) Exclusive within a 150-mile radius for 24 months — narrow, time-boxed concession.\nC) Full exclusivity for a 40% price premium.",
    recommendation:
      "Option B. Regional exclusivity costs us nothing we can actually sell in the next 24 months and closes the deal.",
    decisionDeadline: day(7),
    impactIfDelayed:
      "Contract signature slips; the whole ParkPulse vertical roadmap is contingent on this answer.",
    clientKey: "aurora",
    opportunityKey: "kkz-opp-aurora-signage",
    productKey: "kkz-product-parkpulse",
    dataQuality: "FounderReported",
  },
  {
    id: "kkz-dec-second-designer",
    title: "Contract a second motion designer for the Q4 launch stack",
    decisionType: "Resource",
    status: "Preparing",
    owner: "Dana Reyes",
    requestedBy: "Theo Lindqvist",
    priority: "P2",
    ceoTriggers: ["hiring_above_threshold"],
    financialImpact: 7200,
    decisionRequired:
      "Do we bring on a second contract motion designer for 10 weeks to cover the Q4 launch content?",
    whyNow:
      "Theo is the only person who can produce launch reels, and three launches land inside five weeks.",
    options:
      "A) Contract a second designer, ~$7.2k for 10 weeks.\nB) Push two launches into Q1.\nC) Ship launches without motion content.",
    recommendation:
      "Option A — but only after the Aurora deposit lands, so we are not funding it from float.",
    decisionDeadline: day(16),
    impactIfDelayed: "Launch content slips; two clients launch with static assets only.",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-dec-reelengine-v1",
    title: "Retire the Reel Engine v1 template set",
    decisionType: "Product",
    status: "Decided",
    owner: "Theo Lindqvist",
    requestedBy: "Theo Lindqvist",
    priority: "P3",
    ceoTriggers: [],
    financialImpact: 0,
    decisionRequired: "Do we keep maintaining the v1 Reel Engine templates alongside v2?",
    whyNow: "Every v1 fix has to be duplicated into v2; two clients are still on v1.",
    options: "A) Retire v1, migrate both clients.\nB) Maintain both through year end.",
    recommendation: "Retire v1 and migrate.",
    decisionDeadline: day(-9),
    impactIfDelayed: "Duplicate maintenance continues at roughly 3 hrs/week.",
    finalDecision: "Retire v1. Both remaining clients migrate to v2 during their next content cycle.",
    decisionDate: day(-9),
    rationale:
      "Duplicate maintenance cost exceeded the migration cost within two months. No client objected.",
    productKey: "kkz-product-reelengine",
    dataQuality: "FounderReported",
  },
];

const decisionIds: Record<string, string> = {};
for (const d of DECISION_SEEDS) {
  const rec = decisions.create({
    clientRequestId: d.id,
    title: d.title,
    decisionType: d.decisionType,
    status: d.status,
    owner: d.owner,
    requestedBy: d.requestedBy,
    priority: d.priority,
    ceoTriggers: d.ceoTriggers,
    financialImpact: d.financialImpact,
    decisionRequired: d.decisionRequired,
    whyNow: d.whyNow,
    options: d.options,
    recommendation: d.recommendation,
    decisionDeadline: d.decisionDeadline,
    impactIfDelayed: d.impactIfDelayed,
    finalDecision: d.finalDecision,
    decisionDate: d.decisionDate,
    rationale: d.rationale,
    clientId: d.clientKey ? clientIds[d.clientKey] : undefined,
    opportunityId: d.opportunityKey ? opportunityIds[d.opportunityKey] : undefined,
    projectId: d.projectId,
    productId: d.productKey ? productIds[d.productKey] : undefined,
    dataQuality: d.dataQuality,
    authorityLevel: "L2",
  });
  decisionIds[d.id] = rec.id;
}

// ═══════════════════════════════════════════════════════════════════
// 7. RISKS (Object 7) — Probability × Impact, 1–25
// ═══════════════════════════════════════════════════════════════════

const risks = getRiskStore(stateDir);

const RISK_SEEDS = [
  {
    id: "kkz-risk-season-deadline",
    title: "Season-open date is immovable and the companion app is 45% complete",
    category: "Delivery",
    owner: "Dana Reyes",
    status: "Open",
    probability: 4,
    impact: 5, // 20 → Critical
    priority: "P0",
    mitigation:
      "Weekly burn-down against the gate-scan path only; everything non-scan is cut to a fast-follow release.",
    nextReviewDate: day(-3), // OVERDUE review
    nextAction: "Cut the fast-follow scope list and confirm it with Aurora",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(1),
    clientKey: "aurora",
    projectId: "kkz-proj-aurora-companion",
    financialValue: 84000,
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-risk-contractor-bus-factor",
    title: "One contractor holds all FHIR / telehealth knowledge",
    category: "Capacity",
    owner: "Marcus Kingly",
    status: "Open",
    probability: 3,
    impact: 4, // 12 → Critical band
    priority: "P1",
    mitigation:
      "Pair Dana into the FHIR mapping sessions and require written mapping notes in the repo.",
    nextReviewDate: day(10),
    nextAction: "Schedule the first FHIR knowledge-transfer session",
    nextActionOwner: "Marcus Kingly",
    nextActionDate: day(5),
    clientKey: "northlake",
    projectId: "kkz-proj-northlake-telehealth",
    financialValue: 26400,
    dataQuality: "FounderReported",
  },
  {
    id: "kkz-risk-unsigned-license",
    title: "Cobalt Fox build proceeding while the licence agreement is unsigned",
    category: "Legal",
    owner: "Marcus Kingly",
    status: "Monitoring",
    probability: 3,
    impact: 3, // 9 → High
    priority: "P1",
    mitigation: "Development capped at the shared-tenant layer; no partner production tenant provisioned.",
    nextReviewDate: day(6),
    nextAction: "Get a signed letter of intent or stop the build",
    nextActionOwner: "Marcus Kingly",
    nextActionDate: day(4),
    clientKey: "cobaltfox",
    projectId: "kkz-proj-cobaltfox-whitelabel",
    blocked: true,
    blocker: "Licence agreement unsigned — Cobalt Fox legal has had the draft for 11 days",
    financialValue: 32000,
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-risk-phi-review",
    title: "PHI handling in the intake suite has not had a compliance review",
    category: "Privacy",
    owner: "Dana Reyes",
    status: "Open",
    probability: 2,
    impact: 5, // 10 → High
    priority: "P1",
    mitigation: "No production PHI until a reviewed BAA is executed; PoC runs on synthetic records only.",
    nextReviewDate: day(8),
    nextAction: "Book the compliance review with the practice's counsel",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(3),
    clientKey: "northlake",
    projectId: "kkz-proj-northlake-telehealth",
    productKey: "kkz-product-clinicflow",
    financialValue: 18500,
    dataQuality: "OperationsEstimated",
  },
];

const riskIds: Record<string, string> = {};
for (const r of RISK_SEEDS) {
  const rec = risks.create({
    clientRequestId: r.id,
    title: r.title,
    category: r.category,
    owner: r.owner,
    status: r.status,
    probability: r.probability,
    impact: r.impact,
    priority: r.priority,
    mitigation: r.mitigation,
    nextReviewDate: r.nextReviewDate,
    nextAction: r.nextAction,
    nextActionOwner: r.nextActionOwner,
    nextActionDate: r.nextActionDate,
    clientId: r.clientKey ? clientIds[r.clientKey] : undefined,
    projectId: r.projectId,
    productId: r.productKey ? productIds[r.productKey] : undefined,
    blocked: r.blocked,
    blocker: r.blocker,
    financialValue: r.financialValue,
    dataQuality: r.dataQuality,
    authorityLevel: "L1",
  });
  riskIds[r.id] = rec.id;
}

// ═══════════════════════════════════════════════════════════════════
// 8. FINANCIAL COMMITMENTS (Object 8) — money in / money out
// ═══════════════════════════════════════════════════════════════════

const commitments = getCommitmentStore(stateDir);

const COMMITMENT_SEEDS = [
  {
    id: "kkz-comm-aurora-deposit",
    name: "Aurora Peak — Companion App Deposit (30%)",
    commitmentType: "Deposit",
    direction: "Money In",
    status: "Expected", // EXPECTED DEPOSIT
    amount: 25200,
    amountPaid: 0,
    dueDate: day(5),
    owner: "Dana Reyes",
    priority: "P0",
    nextAction: "Chase the signed PO so accounting can release the deposit",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(1),
    clientKey: "aurora",
    projectId: "kkz-proj-aurora-companion",
    opportunityKey: "kkz-opp-aurora-companion",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-comm-northlake-phase1",
    name: "Northlake — Phase 1 Final Invoice",
    commitmentType: "Client Invoice",
    direction: "Money In",
    status: "Invoiced", // past due date → derived OVERDUE
    amount: 12400,
    amountPaid: 4000,
    dueDate: day(-17),
    owner: "Dana Reyes",
    priority: "P0",
    nextAction: "Escalate to the practice manager — 17 days past terms",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(0),
    clientKey: "northlake",
    projectId: "kkz-proj-northlake-telehealth",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-comm-cobaltfox-setup",
    name: "Cobalt Fox — Licence Setup Fee",
    commitmentType: "Client Invoice",
    direction: "Money In",
    status: "Paid",
    amount: 8000,
    amountPaid: 8000,
    dueDate: day(-30),
    owner: "Marcus Kingly",
    priority: "P3",
    clientKey: "cobaltfox",
    projectId: "kkz-proj-cobaltfox-whitelabel",
    opportunityKey: "kkz-opp-cobaltfox-license",
    dataQuality: "FounderReported",
  },
  {
    id: "kkz-comm-priya-september",
    name: "Priya Shah — September Contractor Payment",
    commitmentType: "Contractor Payment",
    direction: "Money Out",
    status: "Expected",
    amount: 6840,
    amountPaid: 0,
    dueDate: day(13),
    owner: "Dana Reyes",
    priority: "P1",
    nextAction: "Confirm September hours before the run",
    nextActionOwner: "Dana Reyes",
    nextActionDate: day(9),
    projectId: "kkz-proj-aurora-companion",
    dataQuality: "OperationsEstimated",
  },
  {
    id: "kkz-comm-aurora-milestone2",
    name: "Aurora Peak — Milestone 2 Payment (gate-scan acceptance)",
    commitmentType: "Milestone Payment",
    direction: "Money In",
    status: "Expected",
    amount: 21000,
    amountPaid: 0,
    dueDate: day(40),
    owner: "Marcus Kingly",
    priority: "P1",
    nextAction: "Get written acceptance criteria for the gate-scan milestone",
    nextActionOwner: "Marcus Kingly",
    nextActionDate: day(12),
    clientKey: "aurora",
    projectId: "kkz-proj-aurora-companion",
    opportunityKey: "kkz-opp-aurora-companion",
    dataQuality: "OperationsEstimated",
  },
];

const commitmentIds: Record<string, string> = {};
for (const c of COMMITMENT_SEEDS) {
  const rec = commitments.create({
    clientRequestId: c.id,
    name: c.name,
    commitmentType: c.commitmentType,
    direction: c.direction,
    status: c.status,
    amount: c.amount,
    amountPaid: c.amountPaid,
    dueDate: c.dueDate,
    owner: c.owner,
    priority: c.priority,
    nextAction: c.nextAction,
    nextActionOwner: c.nextActionOwner,
    nextActionDate: c.nextActionDate,
    clientId: c.clientKey ? clientIds[c.clientKey] : undefined,
    projectId: c.projectId,
    opportunityId: c.opportunityKey ? opportunityIds[c.opportunityKey] : undefined,
    dataQuality: c.dataQuality,
    authorityLevel: "L1",
    createdBy: CREATED_BY,
  });
  commitmentIds[c.id] = rec.id;
}

// ═══════════════════════════════════════════════════════════════════
// 9. THE RELATIONSHIP GRAPH (§14 typed edges)
// ═══════════════════════════════════════════════════════════════════

const relations = getRelationsStore(stateDir);

interface EdgeSpec {
  fromType: string;
  fromId: string | undefined;
  edge: string;
  toType: string;
  toId: string | undefined;
  meta?: Record<string, unknown>;
}

const EDGE_SPECS: EdgeSpec[] = [];
const edge = (
  fromType: string,
  fromId: string | undefined,
  e: string,
  toType: string,
  toId: string | undefined,
  meta?: Record<string, unknown>,
) => EDGE_SPECS.push({ fromType, fromId, edge: e, toType, toId, meta });

// ── client_has_opportunity ──
for (const o of OPPORTUNITY_SEEDS) {
  edge("client", clientIds[o.clientKey], "client_has_opportunity", "opportunity", opportunityIds[o.id], {
    stage: o.stage,
    value: o.estimatedValue,
  });
}

// ── product_offered_in_opportunity ──
for (const o of OPPORTUNITY_SEEDS) {
  edge(
    "product",
    productIds[o.productKey],
    "product_offered_in_opportunity",
    "opportunity",
    opportunityIds[o.id],
  );
}

// ── opportunity_becomes_project / project_delivers_product ──
for (const p of PROJECT_SEEDS) {
  edge("opportunity", opportunityIds[p.opportunityKey], "opportunity_becomes_project", "project", p.id, {
    status: p.status,
  });
  edge("project", p.id, "project_delivers_product", "product", productIds[p.productKey]);
}

// ── project_has_task + task_assigned_to_person ──
for (const t of TASK_SEEDS) {
  edge("project", t.projectId, "project_has_task", "task", taskIds[t.key], { status: t.status });
  if (t.personKey) {
    edge("task", taskIds[t.key], "task_assigned_to_person", "person", personIds[t.personKey], {
      status: t.status,
    });
  }
}

// ── decision_guides_task ──
edge(
  "decision",
  decisionIds["kkz-dec-companion-stack"],
  "decision_guides_task",
  "task",
  taskIds["kkz-task-aurora-wallet"],
);
edge(
  "decision",
  decisionIds["kkz-dec-signage-pricing"],
  "decision_guides_task",
  "task",
  taskIds["kkz-task-signage-hardware"],
);
edge(
  "decision",
  decisionIds["kkz-dec-parkpulse-ip"],
  "decision_guides_task",
  "task",
  taskIds["kkz-task-cobaltfox-terms"],
);
edge(
  "decision",
  decisionIds["kkz-dec-reelengine-v1"],
  "decision_guides_task",
  "task",
  taskIds["kkz-task-reelengine-retire"],
);

// ── risk_impacts_task ──
edge(
  "risk",
  riskIds["kkz-risk-season-deadline"],
  "risk_impacts_task",
  "task",
  taskIds["kkz-task-aurora-loadtest"],
);
edge(
  "risk",
  riskIds["kkz-risk-contractor-bus-factor"],
  "risk_impacts_task",
  "task",
  taskIds["kkz-task-northlake-fhir"],
);
edge(
  "risk",
  riskIds["kkz-risk-unsigned-license"],
  "risk_impacts_task",
  "task",
  taskIds["kkz-task-cobaltfox-tenant"],
);
edge(
  "risk",
  riskIds["kkz-risk-phi-review"],
  "risk_impacts_task",
  "task",
  taskIds["kkz-task-northlake-baa"],
);

// ── commitment_funds_project ──
for (const c of COMMITMENT_SEEDS) {
  edge("commitment", commitmentIds[c.id], "commitment_funds_project", "project", c.projectId, {
    direction: c.direction,
    amount: c.amount,
  });
}

// ── relates_to: accountability edges pointing AT the person ──
// `PersonStore.workloadFor` reads INCOMING links, so an owner edge has to run
// object → person for the People view to show a real workload picture.
const PERSON_BY_NAME: Record<string, string> = {
  "Marcus Kingly": personIds["kkz-person-marcus"],
  "Dana Reyes": personIds["kkz-person-dana"],
  "Priya Shah": personIds["kkz-person-priya"],
  "Theo Lindqvist": personIds["kkz-person-theo"],
  "Sam Okafor": personIds["kkz-person-sam"],
};

// Delivery owner of each project (mirrors the owning opportunity's owner).
const PROJECT_OWNERS: Record<string, string> = {
  "kkz-proj-aurora-companion": "Dana Reyes",
  "kkz-proj-northlake-telehealth": "Dana Reyes",
  "kkz-proj-cobaltfox-whitelabel": "Marcus Kingly",
  "kkz-proj-parkpulse-signage": "Dana Reyes",
};
for (const [projectId, ownerName] of Object.entries(PROJECT_OWNERS)) {
  edge("project", projectId, "relates_to", "person", PERSON_BY_NAME[ownerName], {
    role: "delivery owner",
  });
}
for (const d of DECISION_SEEDS) {
  edge("decision", decisionIds[d.id], "relates_to", "person", PERSON_BY_NAME[d.owner], {
    role: "decision owner",
  });
}
for (const r of RISK_SEEDS) {
  edge("risk", riskIds[r.id], "relates_to", "person", PERSON_BY_NAME[r.owner], {
    role: "risk owner",
  });
}
edge("client", clientIds["cobaltfox"], "relates_to", "person", personIds["kkz-person-sam"], {
  role: "partner contact",
});
edge("product", productIds["kkz-product-core"], "relates_to", "person", personIds["kkz-person-marcus"], {
  role: "product owner",
});

let edgesCreated = 0;
let edgesSkipped = 0;
const edgeCounts: Record<string, number> = {};
for (const spec of EDGE_SPECS) {
  if (!spec.fromId || !spec.toId) {
    edgesSkipped++;
    continue;
  }
  const before = relations.findMatch({
    fromType: spec.fromType,
    fromId: spec.fromId,
    edge: spec.edge,
    toType: spec.toType,
    toId: spec.toId,
  });
  relations.create({
    fromType: spec.fromType,
    fromId: spec.fromId,
    edge: spec.edge,
    toType: spec.toType,
    toId: spec.toId,
    createdBy: CREATED_BY,
    meta: spec.meta ?? {},
  });
  if (!before) edgesCreated++;
  edgeCounts[spec.edge] = (edgeCounts[spec.edge] ?? 0) + 1;
}

// ═══════════════════════════════════════════════════════════════════
// 10. VERIFY — read back from the live stores
// ═══════════════════════════════════════════════════════════════════

say("═".repeat(72));
say("  KINGLY KREATIONZ — KIS PHASE 1 DEMO SEED");
say("═".repeat(72));
say(`state dir : ${stateDir}`);
say(`seeded at : ${new Date(NOW).toISOString()}`);
say("");

say("── WRITE SUMMARY ─────────────────────────────────────────────────────");
say(`clients created this run     : ${clientsCreated} (of ${CLIENT_SEEDS.length} seeds)`);
say(`kanban projects created      : ${projectsCreated} (of ${PROJECT_SEEDS.length} seeds)`);
say(`kanban tasks created         : ${tasksCreated} (of ${TASK_SEEDS.length} seeds)`);
say(`relation edges created       : ${edgesCreated} new, ${EDGE_SPECS.length - edgesSkipped} total specs, ${edgesSkipped} skipped (unresolved id)`);
say("");

const allClients = agency.listClients(DEFAULT_AGENCY_ID);
const seededClients = allClients.filter((c) => Object.values(clientIds).includes(c.id));
const allProjects = await kanban.getProjects();
const allTasks = await kanban.getTasks();
const seededProjectIds = new Set(PROJECT_SEEDS.map((p) => p.id));
const seededTaskIds = new Set(Object.values(taskIds));

const oppList = opportunities.list({ limit: 1000 });
const prodList = products.list({ limit: 1000 });
const decList = decisions.list({ limit: 1000 });
const riskList = risks.list({ limit: 1000 });
const commList = commitments.list({ limit: 1000 });
const personList = persons.list({ limit: 1000 });

const seeded = <T extends { id: string }>(rows: T[], ids: Record<string, string>) =>
  rows.filter((r) => Object.values(ids).includes(r.id)).length;

say("── LIVE STORE COUNTS (total / seeded by this script) ────────────────");
say(`clients        : ${allClients.length} / ${seededClients.length}`);
say(`people         : ${personList.length} / ${seeded(personList, personIds)}`);
say(`products       : ${prodList.length} / ${seeded(prodList, productIds)}`);
say(`opportunities  : ${oppList.length} / ${seeded(oppList, opportunityIds)}`);
say(`projects       : ${allProjects.length} / ${allProjects.filter((p) => seededProjectIds.has(p.id)).length}`);
say(`tasks          : ${allTasks.length} / ${allTasks.filter((t) => seededTaskIds.has(t.id)).length}`);
say(`decisions      : ${decList.length} / ${seeded(decList, decisionIds)}`);
say(`risks          : ${riskList.length} / ${seeded(riskList, riskIds)}`);
say(`commitments    : ${commList.length} / ${seeded(commList, commitmentIds)}`);
say("");

say("── RELATION GRAPH ───────────────────────────────────────────────────");
const allEdges = relations.list({ limit: 5000 });
say(`total edges in object-relations.db : ${allEdges.length}`);
for (const [name, n] of Object.entries(edgeCounts).sort()) {
  say(`  ${name.padEnd(32)} ${n}`);
}
say("");

// Traversal proof: the Aurora companion project should reach client, opportunity,
// product, tasks, people, decisions, risks and commitments from a single root.
const auroraGraph = relations.graphFor("project", "kkz-proj-aurora-companion", 3);
const byType: Record<string, number> = {};
for (const n of auroraGraph.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
say("graph traversal from project:kkz-proj-aurora-companion (depth 3)");
say(`  reachable nodes : ${auroraGraph.nodes.length}`);
say(`  connecting edges: ${auroraGraph.edges.length}`);
say(`  by type         : ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", ")}`);
say("");

say("── SURFACE CHECKS ───────────────────────────────────────────────────");
const ceoQueue = decList.filter(
  (d) => d.status === "Ready for Decision" || d.status === "CEO Review",
);
say(`CEO queue (Ready for Decision / CEO Review) : ${ceoQueue.length}`);
for (const d of ceoQueue) {
  say(`  • [${d.priority}] ${d.title} — due ${d.decisionDeadline} — triggers: ${(d.ceoTriggers || []).join(", ") || "(inferred)"}`);
}
const ceoOpps = oppList.filter((o) => o.ceoRequired);
say(`CEO-required opportunities                  : ${ceoOpps.length}`);
for (const o of ceoOpps) say(`  • ${o.name} — $${o.estimatedValue.toLocaleString()} (${o.stage})`);

const criticalRisks = riskList.filter((r) => r.riskScore >= 12);
say(`critical risks (score ≥ 12)                 : ${criticalRisks.length}`);
for (const r of criticalRisks) {
  say(`  • ${r.title} — ${r.probability}×${r.impact}=${r.riskScore} (${r.riskLevel}) review ${r.nextReviewDate}`);
}

const overdueComms = commList.filter((c) => c.overdue);
say(`overdue commitments                         : ${overdueComms.length}`);
for (const c of overdueComms) {
  say(`  • ${c.name} — $${c.remainingBalance.toLocaleString()} outstanding, due ${c.dueDate}`);
}
const expectedDeposits = commList.filter(
  (c) => c.commitmentType === "Deposit" && c.status === "Expected",
);
say(`expected deposits                           : ${expectedDeposits.length}`);
for (const c of expectedDeposits) say(`  • ${c.name} — $${c.amount.toLocaleString()} due ${c.dueDate}`);

const agg = commitments.computeAggregates();
say(
  `money expected $${agg.moneyExpected.toLocaleString()} · owed $${agg.moneyOwed.toLocaleString()} · overdue $${agg.moneyOverdue.toLocaleString()} · deposits outstanding $${agg.depositsNotReceived.toLocaleString()}`,
);

const seededTaskRows = allTasks.filter((t) => seededTaskIds.has(t.id));
const overdueTasks = seededTaskRows.filter(
  (t) => t.status !== "done" && t.dueDate && t.dueDate < day(0),
);
const ownerlessTasks = seededTaskRows.filter(
  (t) => t.status !== "done" && !t.assignee && !t.assignedAgent,
);
say(`seeded tasks overdue                        : ${overdueTasks.length}`);
say(`seeded tasks with no owner (§27)            : ${ownerlessTasks.length}`);
say("");

say("── PEOPLE WORKLOAD (derived from the edge store) ────────────────────");
for (const p of personList.filter((x) => Object.values(personIds).includes(x.id))) {
  const w = persons.workloadFor(p.id);
  say(
    `  ${p.name.padEnd(18)} ${String(p.role).padEnd(34)} tasks=${w.taskCount} active=${w.activeTaskCount} links=${w.totalLinks}`,
  );
}
say("");
say("Done. Refresh /opportunities, /ceo, /ops, /people, /decisions, /risks,");
say("/commitments and /clients — the live gateway reads these same SQLite files.");
say("═".repeat(72));

// Persist the run output.
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/seed-kis-demo.txt", OUT.join("\n") + "\n", "utf8");
console.log("\n[wrote /tmp/seed-kis-demo.txt]");

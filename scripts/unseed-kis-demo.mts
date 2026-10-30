/**
 * Remove the "Kingly Kreationz" demo dataset written by scripts/seed-kis-demo.mts
 * from the LIVE KIS Phase 1 object stores under the runtime state dir.
 *
 * Usage:
 *   node --import tsx scripts/unseed-kis-demo.mts --dry-run
 *   node --import tsx scripts/unseed-kis-demo.mts
 *   node --import tsx scripts/unseed-kis-demo.mts --include-pre-seed-fixtures
 *
 * Why in-process: every store resolves its SQLite file under ~/.infinibot — the
 * SAME files the running gateway reads — so deletions land immediately with no
 * gateway restart.
 *
 * SURGICAL BY DEFAULT. Nothing is deleted unless it is positively identified as
 * seed output:
 *   - the six KIS object stores use the seed's deterministic `kkz-*` ids;
 *   - clients match a seed name AND carry a demo marker (.demo email or the
 *     "[DEMO DATA]" note) AND live under the `default` agency;
 *   - kanban projects match a `kkz-proj-*` id AND the seed's project name;
 *   - kanban tasks live in a seed project AND match a seed title AND carry the
 *     "kis-demo" tag or the "[DEMO]" description prefix;
 *   - relation edges are removed only when an endpoint is an object this run
 *     actually deleted (i.e. they would otherwise dangle).
 * Anything that fails a check is REPORTED, never guessed at.
 *
 * --include-pre-seed-fixtures additionally removes the six ACME/"demo-*" fixture
 * records that predate seed-kis-demo.mts (one per object store, left over from
 * KIS Phase 1 development). They are NOT seed output, so they are opt-in — but
 * they are demonstrably mock: they reference `client:demo-client-acme`,
 * `project:demo-project-website` and `task:demo-task-hero`, none of which exist
 * as real records.
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

const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_FIXTURES = process.argv.includes("--include-pre-seed-fixtures");

const OUT: string[] = [];
function say(line = ""): void {
  OUT.push(line);
  console.log(line);
}

const ambiguous: string[] = [];
function flag(line: string): void {
  ambiguous.push(line);
}

// ═══════════════════════════════════════════════════════════════════
// WHAT THE SEED CREATED (mirrors scripts/seed-kis-demo.mts exactly)
// ═══════════════════════════════════════════════════════════════════

const SEED_IDS = {
  person: [
    "kkz-person-marcus",
    "kkz-person-dana",
    "kkz-person-priya",
    "kkz-person-theo",
    "kkz-person-sam",
  ],
  product: [
    "kkz-product-core",
    "kkz-product-parkpulse",
    "kkz-product-clinicflow",
    "kkz-product-reelengine",
  ],
  opportunity: [
    "kkz-opp-northlake-intake",
    "kkz-opp-cobaltfox-license",
    "kkz-opp-aurora-signage",
    "kkz-opp-northlake-telehealth",
    "kkz-opp-aurora-companion",
  ],
  decision: [
    "kkz-dec-companion-stack",
    "kkz-dec-signage-pricing",
    "kkz-dec-parkpulse-ip",
    "kkz-dec-second-designer",
    "kkz-dec-reelengine-v1",
  ],
  risk: [
    "kkz-risk-season-deadline",
    "kkz-risk-contractor-bus-factor",
    "kkz-risk-unsigned-license",
    "kkz-risk-phi-review",
  ],
  commitment: [
    "kkz-comm-aurora-deposit",
    "kkz-comm-northlake-phase1",
    "kkz-comm-cobaltfox-setup",
    "kkz-comm-priya-september",
    "kkz-comm-aurora-milestone2",
  ],
} as const;

/** Pre-existing mock fixtures that predate the seed script (opt-in removal). */
const PRE_SEED_FIXTURE_IDS: Record<keyof typeof SEED_IDS, string[]> = {
  opportunity: ["c2a5c03a-2f5c-47f1-af55-ac8a415bdb8e"], // "ACME Website Rebuild"
  product: ["c3f3433c-d1a7-4354-96a4-0306e958548a"], // "Growth Site Platform"
  decision: ["45af4745-cfd5-4cf0-943d-ab555e845079"], // "Approve ACME proposal at $45k"
  risk: ["d8e09781-a566-4a0a-95bf-488588fc573f"], // "ACME timeline risk — 3wk window"
  commitment: ["47af3f8b-83c3-4090-a8c3-b89d0c2c9075"], // "ACME 50% deposit"
  person: ["50a82112-966c-40db-b1c7-e182e33b8e02"], // "Jordan (Designer)"
};

const SEED_CLIENT_NAMES = [
  "Aurora Peak Adventure Park",
  "Northlake Family Medical",
  "Cobalt Fox Digital",
];

const SEED_PROJECTS: Record<string, string> = {
  "kkz-proj-aurora-companion": "Aurora Peak — Season Pass Companion App",
  "kkz-proj-northlake-telehealth": "Northlake — Telehealth Portal Phase 2",
  "kkz-proj-cobaltfox-whitelabel": "Cobalt Fox — White-Label Platform Rollout",
  "kkz-proj-parkpulse-signage": "ParkPulse Pilot — Aurora Peak Ride Signage",
};

const SEED_TASK_TITLES = new Set([
  "Season-pass wallet: offline pass rendering",
  "Live park map — ride status overlay",
  "Onboarding motion sequence + app store assets",
  "Season-open load test (12k concurrent pass scans)",
  "Return BAA addendum redlines to Northlake counsel",
  "FHIR summary export for post-visit notes",
  "Partner tenant provisioning + theming pipeline",
  "Draft reseller support-tier SLA",
  "Spec the 14-panel hardware bill of materials",
  "Signage layout system + legibility pass at 20ft",
  "Migrate Aurora launch reels off the v1 template set",
]);

// ═══════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════

const stateDir = resolveStateDir();
const agency = getAgencyOperationsStore(stateDir);
const kanban = getKanbanStore(stateDir);
const relations = getRelationsStore(stateDir);

const objectStores = {
  opportunity: getOpportunityStore(stateDir),
  product: getProductStore(stateDir),
  decision: getDecisionStore(stateDir),
  risk: getRiskStore(stateDir),
  commitment: getCommitmentStore(stateDir),
  person: getPersonStore(stateDir),
} as const;

type ObjectKind = keyof typeof objectStores;

say("═".repeat(72));
say("  KIS DEMO UNSEED" + (DRY_RUN ? "  (DRY RUN — nothing will be deleted)" : ""));
say("═".repeat(72));
say(`state dir  : ${stateDir}`);
say(`fixtures   : ${INCLUDE_FIXTURES ? "INCLUDED (pre-seed ACME mock records)" : "left in place"}`);
say("");

// ═══════════════════════════════════════════════════════════════════
// 0. BEFORE COUNTS
// ═══════════════════════════════════════════════════════════════════

const beforeCounts: Record<string, number> = {};
for (const [kind, store] of Object.entries(objectStores))
  beforeCounts[kind] = store.list({ limit: 5000 }).length;
beforeCounts.clients_default = agency.listClients(DEFAULT_AGENCY_ID).length;
const projectsBefore = await kanban.getProjects();
const tasksBefore = await kanban.getTasks();
beforeCounts.kanban_projects = projectsBefore.length;
beforeCounts.kanban_tasks = tasksBefore.length;
// Real (non-seed) kanban volume — this is the number that must NOT drop.
beforeCounts.kanban_projects_real = projectsBefore.filter((p) => !p.id.startsWith("kkz-")).length;
beforeCounts.kanban_tasks_real = tasksBefore.filter(
  (t) => !(Array.isArray(t.tags) && t.tags.includes("kis-demo")),
).length;
beforeCounts.relation_edges = relations.list({ limit: 20000 }).length;

say("── BEFORE ───────────────────────────────────────────────────────────");
for (const [k, v] of Object.entries(beforeCounts)) say(`  ${k.padEnd(20)} ${v}`);
say("");

// ═══════════════════════════════════════════════════════════════════
// 1. RESOLVE THE DELETION SET (identify first, delete later)
// ═══════════════════════════════════════════════════════════════════

/** Every "<type>:<id>" this run will remove — used to prune dangling edges. */
const doomed = new Set<string>();
const objectTargets: { kind: ObjectKind; id: string; label: string; fixture: boolean }[] = [];

for (const kind of Object.keys(objectStores) as ObjectKind[]) {
  const store = objectStores[kind];
  const wanted = [
    ...(SEED_IDS[kind] as readonly string[]).map((id) => ({ id, fixture: false })),
    ...(INCLUDE_FIXTURES ? PRE_SEED_FIXTURE_IDS[kind].map((id) => ({ id, fixture: true })) : []),
  ];
  for (const { id, fixture } of wanted) {
    const rec = store.get(id) as { name?: string; title?: string } | null;
    if (!rec) continue; // already gone — nothing to do
    objectTargets.push({
      kind,
      id,
      label: rec.name ?? rec.title ?? id,
      fixture,
    });
    doomed.add(`${kind}:${id}`);
  }
  // Anything left over in this store that we are NOT touching gets reported.
  const known = new Set([
    ...(SEED_IDS[kind] as readonly string[]),
    ...PRE_SEED_FIXTURE_IDS[kind],
  ]);
  for (const r of store.list({ limit: 5000 }) as { id: string; name?: string; title?: string }[]) {
    if (!known.has(r.id))
      flag(`${kind}: unrecognised record kept — ${r.id} "${r.name ?? r.title ?? ""}"`);
    else if (!INCLUDE_FIXTURES && PRE_SEED_FIXTURE_IDS[kind].includes(r.id))
      flag(
        `${kind}: pre-seed mock fixture kept (use --include-pre-seed-fixtures) — ${r.id} "${r.name ?? r.title ?? ""}"`,
      );
  }
}

// ── clients: seed name + demo marker + default agency ──
const clientTargets: { id: string; name: string }[] = [];
for (const c of agency.listClients(DEFAULT_AGENCY_ID)) {
  const nameMatch = SEED_CLIENT_NAMES.some((n) => n.toLowerCase() === c.name.toLowerCase());
  const marker =
    (c.email ?? "").endsWith(".demo") || (c.notes ?? "").includes("[DEMO DATA]");
  if (nameMatch && marker) {
    clientTargets.push({ id: c.id, name: c.name });
    doomed.add(`client:${c.id}`);
  } else if (nameMatch) {
    flag(`client: name matches a seed client but carries no demo marker — KEPT: ${c.id} "${c.name}"`);
  }
}

// ── kanban projects: seed id + seed name ──
const projectTargets: { id: string; name: string }[] = [];
for (const p of projectsBefore) {
  const expected = SEED_PROJECTS[p.id];
  if (!expected) continue;
  if (expected === p.name) {
    projectTargets.push({ id: p.id, name: p.name });
    doomed.add(`project:${p.id}`);
  } else {
    flag(`project: seed id "${p.id}" but the name was changed to "${p.name}" — KEPT`);
  }
}
const seedProjectIds = new Set(projectTargets.map((p) => p.id));

// ── kanban tasks: inside a seed project + seed title + demo marker ──
const taskTargets: { id: string; title: string }[] = [];
for (const t of tasksBefore) {
  if (!seedProjectIds.has(t.projectId)) continue;
  const titleMatch = SEED_TASK_TITLES.has(t.title);
  const marker =
    (Array.isArray(t.tags) && t.tags.includes("kis-demo")) ||
    (t.description ?? "").startsWith("[DEMO]");
  if (titleMatch && marker) {
    taskTargets.push({ id: t.id, title: t.title });
    doomed.add(`task:${t.id}`);
  } else {
    flag(
      `task: lives in seed project ${t.projectId} but is not seed output — KEPT: ${t.id} "${t.title}"`,
    );
  }
}

// ── relation edges: any edge with an endpoint we are deleting ──
const allEdges = relations.list({ limit: 20000 });
const edgeTargets = allEdges.filter(
  (e) => doomed.has(`${e.fromType}:${e.fromId}`) || doomed.has(`${e.toType}:${e.toId}`),
);

say("── TO REMOVE ────────────────────────────────────────────────────────");
for (const kind of Object.keys(objectStores) as ObjectKind[]) {
  const rows = objectTargets.filter((t) => t.kind === kind);
  say(
    `  ${kind.padEnd(12)} ${String(rows.length).padStart(3)}  (seed ${rows.filter((r) => !r.fixture).length}, fixture ${rows.filter((r) => r.fixture).length})`,
  );
}
say(`  ${"clients".padEnd(12)} ${String(clientTargets.length).padStart(3)}`);
say(`  ${"projects".padEnd(12)} ${String(projectTargets.length).padStart(3)}`);
say(`  ${"tasks".padEnd(12)} ${String(taskTargets.length).padStart(3)}`);
say(`  ${"edges".padEnd(12)} ${String(edgeTargets.length).padStart(3)}`);
say("");

if (DRY_RUN) {
  say("DRY RUN — stopping before any write.");
  for (const line of ambiguous) say(`  ! ${line}`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// 2. DELETE — edges first, so nothing is silently cascaded away
// ═══════════════════════════════════════════════════════════════════

const removed: Record<string, number> = {};
const edgesByType: Record<string, number> = {};

let edgesRemoved = 0;
for (const e of edgeTargets) {
  if (relations.delete(e.id)) {
    edgesRemoved++;
    edgesByType[e.edge] = (edgesByType[e.edge] ?? 0) + 1;
  }
}
removed.edges = edgesRemoved;

for (const kind of Object.keys(objectStores) as ObjectKind[]) {
  let n = 0;
  for (const t of objectTargets.filter((x) => x.kind === kind))
    if (objectStores[kind].delete(t.id)) n++;
  removed[kind] = n;
}

let tasksRemoved = 0;
for (const t of taskTargets) if (await kanban.deleteTask(t.id)) tasksRemoved++;
removed.tasks = tasksRemoved;

let projectsRemoved = 0;
for (const p of projectTargets) if (await kanban.deleteProject(p.id)) projectsRemoved++;
removed.projects = projectsRemoved;

let clientsRemoved = 0;
for (const c of clientTargets) {
  agency.deleteClient(c.id, { agencyId: DEFAULT_AGENCY_ID, actor: "unseed-kis-demo" });
  clientsRemoved++;
}
removed.clients = clientsRemoved;

say("── REMOVED ──────────────────────────────────────────────────────────");
for (const [k, v] of Object.entries(removed)) say(`  ${k.padEnd(20)} ${v}`);
say("");
say("  edges by type:");
for (const [k, v] of Object.entries(edgesByType).sort()) say(`    ${k.padEnd(34)} ${v}`);
say("");

// ═══════════════════════════════════════════════════════════════════
// 3. VERIFY
// ═══════════════════════════════════════════════════════════════════

say("── AFTER ────────────────────────────────────────────────────────────");
const afterCounts: Record<string, number> = {};
for (const [kind, store] of Object.entries(objectStores))
  afterCounts[kind] = store.list({ limit: 5000 }).length;
afterCounts.clients_default = agency.listClients(DEFAULT_AGENCY_ID).length;
const projectsAfter = await kanban.getProjects();
const tasksAfter = await kanban.getTasks();
afterCounts.kanban_projects = projectsAfter.length;
afterCounts.kanban_tasks = tasksAfter.length;
afterCounts.kanban_projects_real = projectsAfter.filter((p) => !p.id.startsWith("kkz-")).length;
afterCounts.kanban_tasks_real = tasksAfter.filter(
  (t) => !(Array.isArray(t.tags) && t.tags.includes("kis-demo")),
).length;
afterCounts.relation_edges = relations.list({ limit: 20000 }).length;
for (const [k, v] of Object.entries(afterCounts))
  say(`  ${k.padEnd(20)} ${String(v).padStart(6)}   (was ${beforeCounts[k]})`);
say("");

// residual seed material anywhere?
const residual: string[] = [];
for (const [kind, store] of Object.entries(objectStores))
  for (const r of store.list({ limit: 5000 }) as { id: string }[])
    if (r.id.startsWith("kkz-")) residual.push(`${kind}:${r.id}`);
for (const p of projectsAfter) if (p.id.startsWith("kkz-")) residual.push(`project:${p.id}`);
for (const t of tasksAfter)
  if (Array.isArray(t.tags) && t.tags.includes("kis-demo")) residual.push(`task:${t.id}`);
for (const c of agency.listClients(DEFAULT_AGENCY_ID))
  if (SEED_CLIENT_NAMES.some((n) => n.toLowerCase() === c.name.toLowerCase()))
    residual.push(`client:${c.id}`);

// dangling edges: an endpoint that no longer resolves in any store we know
const resolvers: Record<string, (id: string) => boolean> = {
  opportunity: (id) => !!objectStores.opportunity.get(id),
  product: (id) => !!objectStores.product.get(id),
  decision: (id) => !!objectStores.decision.get(id),
  risk: (id) => !!objectStores.risk.get(id),
  commitment: (id) => !!objectStores.commitment.get(id),
  person: (id) => !!objectStores.person.get(id),
  project: (id) => projectsAfter.some((p) => p.id === id),
  task: (id) => tasksAfter.some((t) => t.id === id),
  client: (id) => !!agency.getClient(id, DEFAULT_AGENCY_ID),
};
const dangling = relations.list({ limit: 20000 }).filter((e) => {
  const f = resolvers[e.fromType];
  const t = resolvers[e.toType];
  return (f && !f(e.fromId)) || (t && !t(e.toId));
});

say(`residual seed records : ${residual.length}${residual.length ? " — " + residual.join(", ") : " ✓"}`);
say(`dangling edges left   : ${dangling.length}`);
for (const e of dangling)
  say(`    ${e.id} | ${e.fromType}:${e.fromId} -[${e.edge}]-> ${e.toType}:${e.toId}`);
say("");

say("── KEPT / NEEDS A HUMAN ─────────────────────────────────────────────");
if (!ambiguous.length) say("  (none)");
for (const line of ambiguous) say(`  ! ${line}`);
say("");
say("═".repeat(72));

const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/unseed-kis-demo.txt", OUT.join("\n") + "\n");
say("report written to /tmp/unseed-kis-demo.txt");

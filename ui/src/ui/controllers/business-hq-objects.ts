/**
 * Business HQ — live object-store loader.
 *
 * The /dashboard HQ historically derived its six sections from kanban child
 * projects. Phase 1 introduces real object stores (opportunity / product /
 * decision / risk / commitment / person) served over the gateway. This loader
 * pulls those live records so the HQ can read the *actual* objects, and the CEO
 * Focus panel can read the Decisions CEO queue + critical Risks + overdue
 * Commitments (spec §14).
 *
 * Self-contained (module-level state, own RPC calls) so it doesn't couple to the
 * per-view controllers. Every call is independently guarded: the `*.list`
 * methods only respond once the gateway has been restarted to serve them, so a
 * pre-restart gateway simply leaves that slice empty and the HQ transparently
 * falls back to its kanban-derived rendering — never a crash, never fabricated
 * data.
 */
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { isTabAvailable } from "../plugin-host.js";

export interface HqOpportunity {
  id: string; name: string; owner: string; stage: string; status: string; priority: string;
  estimatedValue: number; clientId?: string; productId?: string; projectId?: string;
  needsAction?: boolean; stale?: boolean; blocked?: boolean; ceoRequired?: boolean; escalationRequired?: boolean;
  nextAction?: string; nextActionDate?: string; lastUpdated?: number;
}
export interface HqProduct {
  id: string; name: string; productType: string; status: string; validationStage: string; priority: string; owner: string;
}
export interface HqDecision {
  id: string; title: string; status: string; owner: string; priority: string; ceoRequired?: boolean;
  decisionDeadline?: string; decisionRequired?: string; recommendation?: string; requestedBy?: string;
  // §17 CEO REQUEST FORMAT fields + §16 triggers (served once the gateway is
  // restarted; absent on a pre-restart gateway → the view derives fallbacks).
  decisionType?: string; whyNow?: string; options?: string; impactIfDelayed?: string;
  ceoTriggers?: string[]; financialImpact?: number;
  clientId?: string; opportunityId?: string; projectId?: string; productId?: string;
  lastUpdated?: number;
}
export interface HqRisk {
  id: string; title: string; category: string; owner: string; status: string; priority: string;
  riskScore: number; riskLevel?: string; financialValue?: number; nextReviewDate?: string;
  nextAction?: string; nextActionOwner?: string; nextActionDate?: string; lastUpdated?: number;
}
export interface HqCommitment {
  id: string; name: string; direction: string; status: string; amount: number; dueDate?: string;
  amountPaid: number; remainingBalance: number; overdue: boolean; owner: string; priority: string;
}
export interface HqPerson {
  id: string; name: string; relationshipType: string; role: string; status: string; availability: string; owner: string;
}
export interface HqClient {
  id: string; name: string; status: string; pipelineStatus?: string; owner?: string;
}

export interface HqObjectsState {
  loaded: boolean;
  loading: boolean;
  anyServed: boolean; // true once at least one object RPC responded (gateway has the methods)
  errors: Record<string, string>;
  opportunities: HqOpportunity[];
  products: HqProduct[];
  decisions: HqDecision[];
  ceoDecisions: HqDecision[];
  risks: HqRisk[];
  commitments: HqCommitment[];
  people: HqPerson[];
  clients: HqClient[];
}

export const hqObjectsState: HqObjectsState = {
  loaded: false,
  loading: false,
  anyServed: false,
  errors: {},
  opportunities: [],
  products: [],
  decisions: [],
  ceoDecisions: [],
  risks: [],
  commitments: [],
  people: [],
  clients: [],
};

const kicked = new WeakSet<object>();

async function tryList<T>(
  client: GatewayBrowserClient,
  method: string,
  params: Record<string, unknown>,
  key: keyof HqObjectsState & string,
  extract: (res: any) => T[],
): Promise<T[]> {
  try {
    const res = await client.request(method, params);
    hqObjectsState.anyServed = true;
    return extract(res) ?? [];
  } catch (e) {
    hqObjectsState.errors[method] = String(e);
    return [];
  }
}

/**
 * Bumped on every object write. A list that started before a write may carry
 * the pre-write rows (e.g. a decision still "CEO Review" after Decide), and
 * assigning it would bring the item back — such a load re-lists instead.
 */
let objectWriteSeq = 0;
export function noteHqObjectWrite(): void {
  objectWriteSeq += 1;
}

/** Load all Phase-1 object stores. Safe to call repeatedly; guards each RPC. */
export async function loadHqObjects(app: AppViewState, client: GatewayBrowserClient, attempt = 0): Promise<void> {
  const seqAtStart = objectWriteSeq;
  hqObjectsState.loading = true;
  hqObjectsState.errors = {};
  const [opps, products, decisions, ceo, risks, commitments, people, clients] = await Promise.all([
    tryList<HqOpportunity>(client, "opportunity.list", {}, "opportunities", (r) => r?.opportunities),
    // Optional integration: product cards only while the Products plugin is on.
    isTabAvailable("product-portfolio")
      ? tryList<HqProduct>(client, "product.list", {}, "products", (r) => r?.products)
      : Promise.resolve([] as HqProduct[]),
    tryList<HqDecision>(client, "decision.list", {}, "decisions", (r) => r?.decisions),
    tryList<HqDecision>(client, "decision.ceoQueue", {}, "ceoDecisions", (r) => r?.decisions),
    tryList<HqRisk>(client, "risk.list", {}, "risks", (r) => r?.risks),
    tryList<HqCommitment>(client, "commitment.list", {}, "commitments", (r) => r?.commitments),
    tryList<HqPerson>(client, "person.list", {}, "people", (r) => r?.people),
    tryList<HqClient>(client, "clients.list", { pageSize: 500 }, "clients", (r) => r?.clients),
  ]);
  if (objectWriteSeq !== seqAtStart && attempt < 3) {
    return loadHqObjects(app, client, attempt + 1);
  }
  hqObjectsState.opportunities = opps;
  hqObjectsState.products = products;
  hqObjectsState.decisions = decisions;
  hqObjectsState.ceoDecisions = ceo;
  hqObjectsState.risks = risks;
  hqObjectsState.commitments = commitments;
  hqObjectsState.people = people;
  hqObjectsState.clients = clients;
  hqObjectsState.loaded = true;
  hqObjectsState.loading = false;
  app.requestUpdate?.();
}

/** Kick the initial load once per app instance. */
export function ensureHqObjects(app: AppViewState, client: GatewayBrowserClient): void {
  if (kicked.has(app)) return;
  kicked.add(app);
  void loadHqObjects(app, client);
}

// ── Rule-derived selectors (mirror src/business-objects/rules.ts semantics) ──

/** §26 priority rank — lower = more urgent. */
export function hqPriorityRank(p?: string): number {
  switch ((p || "").toUpperCase()) {
    case "P0": return 0;
    case "P1": return 1;
    case "P2": return 2;
    case "P3": return 3;
    default: return 4;
  }
}

const CRITICAL = new Set(["P0", "P1"]);
export function isCriticalRisk(r: HqRisk): boolean {
  const open = !/closed|mitigated|accepted|resolved/i.test(r.status || "");
  return open && (CRITICAL.has((r.priority || "").toUpperCase()) || /critical|high/i.test(r.riskLevel || ""));
}

export function isOverdueCommitment(c: HqCommitment): boolean {
  if (c.overdue) return true;
  const open = !/paid|settled|closed|cancelled/i.test(c.status || "");
  if (!open || !c.dueDate) return false;
  const due = Date.parse(c.dueDate);
  return !Number.isNaN(due) && due < Date.now() && (c.remainingBalance ?? 0) > 0;
}

/** Decisions requiring the CEO — the ceoQueue if the RPC served it, else derived. */
export function ceoDecisions(): HqDecision[] {
  // The server's queue is authoritative whenever it answered — an empty queue
  // means nothing is waiting, not "derive it". Deriving from decision.list
  // used to resurface Decided decisions (ceoRequired stays true after the
  // call is made) the moment the owner cleared the last one.
  const queueAnswered = hqObjectsState.loaded && !hqObjectsState.errors["decision.ceoQueue"];
  const source = queueAnswered ? hqObjectsState.ceoDecisions : hqObjectsState.decisions;
  return source.filter(
    (d) =>
      isOpenDecision(d) &&
      (queueAnswered || d.ceoRequired || CRITICAL.has((d.priority || "").toUpperCase())),
  );
}

/** Decided / Deferred / Cancelled (and legacy closed/final) leave the CEO queue. */
export function isOpenDecision(d: HqDecision): boolean {
  return !/decided|deferred|cancel|closed|final/i.test(d.status || "");
}

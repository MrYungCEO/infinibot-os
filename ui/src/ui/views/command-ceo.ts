/**
 * Executive Command Center — the CEO's dashboard (spec §15, §16, §17).
 *
 * "This is the management interface. It should NOT display everything. It should
 * display exceptions, priorities and decisions." Where the Business HQ shows the
 * whole organization, this view shows only what needs the CEO — arranged in
 * three bands (§15 TODAY / THIS WEEK / BUSINESS HEALTH), followed by the CEO
 * QUEUE (§16) whose items each render in the structured CEO REQUEST FORMAT (§17).
 *
 * Data is derived from the SAME live sources as the HQ: the kanban board
 * (loadKanban) plus the Phase-1 object stores (business-hq-objects). The CEO
 * Queue applies the §16 CEO Decision Trigger gate (ceo-triggers mirror) so
 * operational work is never disguised as CEO work — everything without a trigger
 * stays out. No fabricated data: absent sources show a labelled empty state.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import type { KanbanProject, KanbanTask } from "../types";
import { loadKanban } from "../controllers/kanban";
import { isTabAvailable } from "../plugin-host.js";
import { baAurora, openHubSection } from "./ba-glass";
import "./ba-glass/hq.css";
import { statCard } from "./kis-shared";
import {
  hqObjectsState,
  ensureHqObjects,
  loadHqObjects,
  isCriticalRisk,
  isOverdueCommitment,
  type HqDecision,
  type HqOpportunity,
  type HqRisk,
} from "../controllers/business-hq-objects";
import {
  evaluateCeoTriggers,
  isCeoDecision,
  ceoTriggerLabels,
  type CeoTriggerInput,
} from "../controllers/ceo-triggers";
import {
  CC_STYLE,
  chip,
  prioChip,
  emptyState,
  bandLabel,
  refreshButton,
  loadingBanner,
  row,
  metric,
  listBlock,
  panel,
  money,
  projectName,
  projectIsActive,
  isBlocked,
  isOverdue,
  isDone,
  dueToday,
  dueWithinDays,
  prioRank,
  fmtDue,
  fmtIsoDue,
  isoWithinDays,
  isoIsPast,
} from "./command-center-shared";

const loadKicked = new WeakSet<object>();

// ── Terminal opportunity stages (not "active") ──
const TERMINAL_OPP = /won|lost|hold/i;
function oppIsActive(o: HqOpportunity): boolean {
  return !TERMINAL_OPP.test(o.stage || o.status || "");
}

/** Build the §16 CEO-trigger input for a decision, enriching with linked opp value. */
function triggerInput(d: HqDecision, opps: HqOpportunity[]): CeoTriggerInput {
  const opp = d.opportunityId ? opps.find((o) => o.id === d.opportunityId) : undefined;
  return {
    decisionType: d.decisionType,
    priority: d.priority,
    ceoRequired: d.ceoRequired,
    title: d.title,
    decisionRequired: d.decisionRequired,
    ceoTriggers: d.ceoTriggers,
    financialImpact: d.financialImpact,
    opportunityValue: opp?.estimatedValue ?? null,
  };
}

// ── §17 fallbacks: when a pre-restart gateway hasn't served whyNow / impact yet,
// derive a defensible line so the CEO card is complete. Derived text is styled
// muted/italic so it's clearly not an operator-authored value.
function deriveWhyNow(d: HqDecision): string {
  if (d.whyNow && d.whyNow.trim()) return d.whyNow;
  if (d.decisionDeadline)
    return `Decision is time-boxed — needed by ${d.decisionDeadline}; dependent work is waiting on the answer.`;
  return "Dependent work cannot proceed until this is settled.";
}
function deriveImpact(d: HqDecision, labels: string[]): string {
  if (d.impactIfDelayed && d.impactIfDelayed.trim()) return d.impactIfDelayed;
  if (labels.includes("Technical architecture decision"))
    return "Technical architecture cannot be finalized; rework risk compounds.";
  if (labels.includes("Opportunity above defined value"))
    return "The opportunity may cool or be lost to a competitor.";
  if (labels.some((l) => /client/i.test(l)))
    return "Client relationship and delivery timeline are at risk.";
  return "Downstream work stalls and the deadline slips.";
}
function isDerived(v: string | undefined): boolean {
  return !(v && v.trim());
}

export function renderCommandCeo(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (!loadKicked.has(state)) {
    loadKicked.add(state);
    void loadKanban(state);
  }
  ensureHqObjects(state, client);

  const projects = (state.kanbanProjects || []) as KanbanProject[];
  const tasks = (state.kanbanTasks || []) as KanbanTask[];
  const loading = state.kanbanLoading && tasks.length === 0;
  const err = state.kanbanError;

  const O = hqObjectsState;
  const openTasks = tasks.filter((t) => !isDone(t));

  // ── CEO-relevant task predicate: consequential AND time-sensitive ──
  const needsCeoTask = (t: KanbanTask): boolean => {
    if (isDone(t)) return false;
    if (t.autonomousStatus === "pending_approval") return true;
    if (isBlocked(t) && prioRank(t) >= 2) return true;
    if (/\bceo\b|sign[- ]?off|\bapprov/i.test(t.title || "")) return true;
    return prioRank(t) >= 2 && (isOverdue(t) || dueWithinDays(t, 7));
  };

  // ── CEO QUEUE (§16): queue-eligible decisions that fire ≥1 trigger ──
  const queueStatus = /ready for decision|ceo review/i;
  const queueEligible = (O.ceoDecisions.length ? O.ceoDecisions : O.decisions.filter((d) => queueStatus.test(d.status || "")));
  const ceoQueue = queueEligible
    .filter((d) => isCeoDecision(triggerInput(d, O.opportunities)))
    .sort((a, b) => {
      const pr = (a.priority || "P2").localeCompare(b.priority || "P2");
      if (pr !== 0) return pr;
      const da = Date.parse(a.decisionDeadline || "") || Infinity;
      const db = Date.parse(b.decisionDeadline || "") || Infinity;
      return da - db;
    });

  // ── §15 TODAY ──
  const ceoTasksToday = openTasks.filter((t) => dueToday(t) && (needsCeoTask(t) || prioRank(t) >= 2));
  const decisionsDue = ceoQueue.filter((d) => isoIsPast(d.decisionDeadline) || isoWithinDays(d.decisionDeadline, 1));
  const criticalBlockers = openTasks.filter((t) => isBlocked(t) && prioRank(t) >= 2);
  const criticalRisks = O.risks.filter(isCriticalRisk).sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  const criticalClientIssues = [
    ...criticalRisks.filter((r) => /client/i.test(r.category || "")),
    ...ceoQueue
      .filter((d) => ceoTriggerLabels(triggerInput(d, O.opportunities)).some((l) => /client/i.test(l)))
      .map((d) => ({ id: d.id, title: d.title, category: "Client decision", owner: d.owner, status: d.status, priority: d.priority, riskScore: 0 } as HqRisk)),
  ];

  // ── §15 THIS WEEK ──
  const majorDeadlines = openTasks
    .filter((t) => dueWithinDays(t, 7) && !dueToday(t) && prioRank(t) >= 2)
    .sort((a, b) => (Date.parse(a.dueDate || "") || 0) - (Date.parse(b.dueDate || "") || 0));
  const importantMeetings = openTasks.filter(
    (t) => dueWithinDays(t, 7) && /\bmeeting\b|\bcall\b|\bsync\b|\bdemo\b|\bpitch\b|\breview w/i.test(t.title || ""),
  );
  const productDecisions = ceoQueue.filter((d) =>
    evaluateCeoTriggers(triggerInput(d, O.opportunities)).includes("product_direction"),
  );
  const projectsApproaching = projects
    .filter((p) => projectIsActive(p) && p.dueDate && isoWithinDays(p.dueDate, 14))
    .sort((a, b) => (Date.parse(a.dueDate || "") || 0) - (Date.parse(b.dueDate || "") || 0));
  const proposalsForApproval = O.opportunities.filter(
    (o) => /proposal/i.test(o.stage || "") || o.ceoRequired || o.escalationRequired,
  );

  // ── §15 BUSINESS HEALTH ──
  const activeClients = O.clients.filter((c) => /active/i.test(c.status || "")).length
    || new Set(
      [...O.opportunities.map((o) => o.clientId), ...O.commitments.map((c) => c.id && (c as any).clientId)]
        .filter(Boolean),
    ).size;
  const activeProjects = projects.filter(projectIsActive);
  const activeOpps = O.opportunities.filter(oppIsActive);
  const pipelineValue = activeOpps.reduce((s, o) => s + (Number(o.estimatedValue) || 0), 0);
  const outstandingInvoices = O.commitments
    .filter((c) => /money in/i.test(c.direction || "") && /invoiced|expected|overdue|partially/i.test(c.status || ""))
    .reduce((s, c) => s + (Number(c.remainingBalance ?? c.amount) || 0), 0);
  const projectsBlocked = activeProjects.filter((p) =>
    tasks.some((t) => t.projectId === p.id && !isDone(t) && (isBlocked(t) || isOverdue(t))),
  ).length;

  const todayCount =
    ceoTasksToday.length + decisionsDue.length + criticalBlockers.length + criticalClientIssues.length + criticalRisks.length;
  const weekCount =
    majorDeadlines.length + importantMeetings.length + productDecisions.length + projectsApproaching.length + proposalsForApproval.length;

  const lastUpdated = state.kanbanRefreshing || O.loading
    ? "syncing…"
    : `${ceoQueue.length} on CEO queue${O.anyServed ? " · live objects" : " · restart gateway to serve object stores"}`;

  return html`
    <div class="kis cc ba-glass">
      ${baAurora()}
      ${CC_STYLE}
      <header class="cc-header" data-learn-id="ceo-header">
        <div>
          <div class="cc-eyebrow">Executive Command Center · CEO</div>
          <h1 class="cc-h1">What needs <span class="bag-gold-text">you.</span></h1>
          <p class="cc-lede">Exceptions, priorities and decisions — nothing else. This dashboard manages your attention; the whole organization lives on the Business HQ.</p>
        </div>
        <div class="cc-header-side">
          <span class="cc-updated">${lastUpdated}</span>
          ${refreshButton(Boolean(state.kanbanRefreshing || O.loading), () => {
            void loadKanban(state);
            void loadHqObjects(state, client);
          })}
        </div>
      </header>

      ${err ? html`<div class="cc-banner cc-banner--err">Failed to load live data: ${err}</div>` : nothing}
      ${loadingBanner(state, loading, {
        onRetry: () => {
          void loadKanban(state);
          void loadHqObjects(state, client);
        },
        rerender: () => state.requestUpdate?.(),
      })}

      <!-- ═══ TODAY ═══ -->
      ${bandLabel("Today", "What only the CEO can move today.", "danger")}
      <div class="cc-grid">
        ${panel("Immediate", "CEO tasks, decisions due, and critical blockers.", html`
          ${listBlock("CEO tasks due today", ceoTasksToday.length,
            ceoTasksToday.slice(0, 5).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip(fmtDue(t), "warn"), prioChip(t.priority)], "warn")),
            "warn", "No CEO tasks due today.")}
          ${listBlock("CEO decisions due", decisionsDue.length,
            decisionsDue.slice(0, 5).map((d) => row(d.title, d.owner || d.decisionType || "", [chip(d.decisionDeadline ? `by ${d.decisionDeadline}` : "no date", "danger"), prioChip(d.priority)], "danger")),
            "danger", "No decisions due today.")}
          ${listBlock("Critical blockers", criticalBlockers.length,
            criticalBlockers.slice(0, 5).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip("blocked", "danger"), prioChip(t.priority)], "danger")),
            "danger", "No critical blockers.")}
        `, { count: ceoTasksToday.length + decisionsDue.length + criticalBlockers.length, countTone: ceoTasksToday.length + decisionsDue.length + criticalBlockers.length ? "warn" : "ok", iconName: "alert" })}

        ${panel("Critical risk & clients", "Critical risks and critical client issues.", html`
          ${listBlock("Critical risks", criticalRisks.length,
            criticalRisks.slice(0, 5).map((r) => row(r.title, `${r.category || "risk"}${r.owner ? ` · ${r.owner}` : ""}`, [r.riskScore ? chip(`score ${r.riskScore}`, "danger") : nothing, prioChip(r.priority)], "danger")),
            "danger", "No critical risks open.")}
          ${listBlock("Critical client issues", criticalClientIssues.length,
            criticalClientIssues.slice(0, 5).map((r) => row(r.title, r.category || "client", [chip("client", "warn"), prioChip(r.priority)], "warn")),
            "warn", "No critical client issues.")}
        `, { count: criticalRisks.length + criticalClientIssues.length, countTone: criticalRisks.length + criticalClientIssues.length ? "danger" : "ok", iconName: "shield" })}
      </div>

      <!-- ═══ THIS WEEK ═══ -->
      ${bandLabel("This Week", "Approaching — plan the week around these.", "gold")}
      <div class="cc-grid">
        ${panel("Deadlines & meetings", "Major deadlines and important meetings.", html`
          ${listBlock("Major deadlines", majorDeadlines.length,
            majorDeadlines.slice(0, 5).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip(fmtDue(t), "gold"), prioChip(t.priority)], "gold")),
            "gold", "No major deadlines this week.")}
          ${listBlock("Important meetings", importantMeetings.length,
            importantMeetings.slice(0, 4).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip(fmtDue(t), "muted")], "muted")),
            "muted", "No meetings flagged.")}
        `, { count: majorDeadlines.length + importantMeetings.length, countTone: majorDeadlines.length + importantMeetings.length ? "gold" : "ok", iconName: "clock" })}

        ${panel("Decisions & delivery", "Product decisions, delivery, and proposals to approve.", html`
          ${listBlock("Product decisions", productDecisions.length,
            productDecisions.slice(0, 4).map((d) => row(d.title, d.decisionType || "Product", [chip("product", "gold"), prioChip(d.priority)], "gold")),
            "gold", "No product decisions pending.")}
          ${listBlock("Projects approaching delivery", projectsApproaching.length,
            projectsApproaching.slice(0, 4).map((p) => row(p.name, `${(p.assignedInstances && p.assignedInstances[0]) || "unassigned"}`, [chip(fmtIsoDue(p.dueDate), "warn")], "warn")),
            "warn", "No projects approaching delivery.")}
          ${listBlock("Proposals requiring approval", proposalsForApproval.length,
            proposalsForApproval.slice(0, 4).map((o) => row(o.name, o.stage || "Proposal", [o.estimatedValue ? chip(money(o.estimatedValue), "gold") : nothing, chip("approve", "warn")], "warn")),
            "warn", "No proposals awaiting approval.")}
        `, { count: productDecisions.length + projectsApproaching.length + proposalsForApproval.length, countTone: productDecisions.length + projectsApproaching.length + proposalsForApproval.length ? "gold" : "ok", iconName: "box" })}
      </div>

      <!-- ═══ BUSINESS HEALTH ═══ -->
      ${bandLabel("Business Health", "The state of the business at a glance.", "info")}
      <div class="cc-metrics">
        ${/* Clients come from the agency client list (clients.list → agency.db),
           the same store as Business hub › Clients, so the tile opens it there. */
        isTabAvailable("hub")
          ? statCard({ label: "Active clients", value: activeClients, tone: "gold", sub: "on the books · open in Business hub", onClick: () => openHubSection(state, "clients") })
          : metric("Active clients", activeClients, "gold", "on the books")}
        ${metric("Active projects", loading ? "—" : activeProjects.length, loading ? "muted" : "gold", loading ? "board not responding" : `${projectsBlocked} blocked`)}
        ${metric("Active opportunities", activeOpps.length, "gold", "still in play")}
        ${metric("Pipeline value", money(pipelineValue), "ok", "weighted at stage value")}
        ${metric("Outstanding invoices", money(outstandingInvoices), outstandingInvoices ? "warn" : "ok", "money-in not yet received")}
        ${metric("Projects blocked", loading ? "—" : projectsBlocked, loading ? "muted" : projectsBlocked ? "danger" : "ok", loading ? "board not responding" : projectsBlocked ? "delivery at risk" : "nothing blocked")}
        ${metric("Critical risks", criticalRisks.length, criticalRisks.length ? "danger" : "ok", "score ≥ 12")}
        ${metric("CEO decisions waiting", ceoQueue.length, ceoQueue.length ? "warn" : "ok", "fired a CEO trigger")}
      </div>

      <!-- ═══ CEO QUEUE (§16) — §17 request format ═══ -->
      ${bandLabel("CEO Queue", "Only items that fired a CEO Decision Trigger. Everything else stays out.", "gold")}
      ${panel(
        "Decisions requiring you",
        "Each item names the trigger that reached you, and is framed so your involvement is efficient (§17).",
        ceoQueue.length
          ? html`<div class="cc-req-list">${ceoQueue.slice(0, 12).map((d) => renderCeoRequest(d, O.opportunities))}</div>`
          : emptyState(
              O.anyServed
                ? "The CEO queue is clear — no decision has fired a CEO Decision Trigger. Operational work stays with Operations."
                : "Decision store loads once the gateway is restarted to serve decision.*. Until then the CEO queue is empty by design.",
            ),
        { count: ceoQueue.length, countTone: ceoQueue.length ? "warn" : "ok", accent: true, iconName: "scale" },
      )}

      <footer class="cc-footer">
        Executive Command Center · KIS Phase 1 · exceptions / priorities / decisions only — derived live from the board + object stores.
      </footer>
    </div>
  `;
}

/** §17 CEO REQUEST FORMAT card for one decision. */
function renderCeoRequest(d: HqDecision, opps: HqOpportunity[]): TemplateResult {
  const input = triggerInput(d, opps);
  const labels = ceoTriggerLabels(input);
  const whyNow = deriveWhyNow(d);
  const impact = deriveImpact(d, labels);
  const optionLines = (d.options || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const field = (k: string, v: string, opts: { derived?: boolean; full?: boolean } = {}) => html`
    <div class="cc-req-field ${opts.full ? "cc-req-full" : ""}">
      <span class="cc-req-k">${k}</span>
      <span class="cc-req-v ${opts.derived ? "cc-req-v--muted" : ""}">${v || "—"}</span>
    </div>
  `;
  return html`
    <div class="cc-req">
      <div class="cc-req-triggers">
        ${labels.length ? labels.map((l) => chip(l, "warn")) : chip("CEO review", "warn")}
        ${prioChip(d.priority)}
      </div>
      <div class="cc-req-title">${d.title || "Decision required"}</div>
      <div class="cc-req-grid">
        ${field("Decision Required", d.decisionRequired || d.title || "", { full: true })}
        ${field("Why now", whyNow, { derived: isDerived(d.whyNow) })}
        ${field("Decision Needed By", d.decisionDeadline || "Not set")}
        <div class="cc-req-field cc-req-full">
          <span class="cc-req-k">Options</span>
          ${optionLines.length
            ? html`<span class="cc-req-v">${optionLines.map((o, i) => html`<div>${/^[a-z0-9][\.\)]/i.test(o) ? o : `${String.fromCharCode(65 + i)}. ${o}`}</div>`)}</span>`
            : html`<span class="cc-req-v cc-req-v--muted">Options not yet enumerated.</span>`}
        </div>
        ${field("Operations Recommendation", d.recommendation || "", { derived: isDerived(d.recommendation), full: true })}
        ${field("Impact if delayed", impact, { derived: isDerived(d.impactIfDelayed), full: true })}
      </div>
      <div class="cc-req-foot">
        ${d.owner ? chip(`owner: ${d.owner}`, "muted") : nothing}
        ${d.requestedBy ? chip(`requested by ${d.requestedBy}`, "muted") : nothing}
        ${d.decisionDeadline ? chip(fmtIsoDue(d.decisionDeadline), isoIsPast(d.decisionDeadline) ? "danger" : "gold") : nothing}
      </div>
    </div>
  `;
}

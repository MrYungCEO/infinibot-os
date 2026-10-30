/**
 * Operations Command Center — the operator's dashboard (spec §18).
 *
 * "Your dashboard should be different. You need broader visibility." Where the
 * Executive Command Center shows only what needs the CEO, this view gives
 * Operations full visibility across four panels:
 *   • Needs Attention — overdue / blocked / missing owners & next actions /
 *     follow-ups / upcoming deadlines / outstanding invoices / unresolved risks /
 *     decisions awaiting preparation.
 *   • Portfolio — all projects, opportunities, clients, product status.
 *   • Workload — work by owner, founder workload, unassigned work.
 *   • System Quality — records not updated, projects without next action,
 *     opportunities without follow-up, risks without owners, decisions past deadline.
 *
 * "This dashboard manages the organization. The CEO dashboard manages the CEO's attention."
 * All data is live: the kanban board (loadKanban) + the Phase-1 object stores
 * (business-hq-objects). Missing sources show a labelled empty state, never mock
 * data. The rule predicates (isStale / needsNextAction) mirror
 * src/business-objects/rules.ts.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import type { KanbanProject, KanbanTask } from "../types";
import { loadKanban } from "../controllers/kanban";
import {
  hqObjectsState,
  ensureHqObjects,
  loadHqObjects,
  isOverdueCommitment,
  type HqRisk,
  type HqDecision,
  type HqOpportunity,
} from "../controllers/business-hq-objects";
import {
  CC_STYLE,
  chip,
  prioChip,
  emptyState,
  row,
  metric,
  bandLabel,
  refreshButton,
  loadingBanner,
  listBlock,
  panel,
  money,
  projectName,
  projectIsActive,
  isBlocked,
  isOverdue,
  isDone,
  dueWithinDays,
  fmtDue,
  fmtIsoDue,
  isoIsPast,
} from "./command-center-shared";
import { isTabAvailable } from "../plugin-host.js";
import { baAurora, openHubSection } from "./ba-glass";
import "./ba-glass/hq.css";

const loadKicked = new WeakSet<object>();

// ── Rule mirrors (src/business-objects/rules.ts) ──
const DAY = 86400000;
const STALE_DAYS: Record<string, number> = { project: 7, opportunity: 7, criticalRisk: 3, normalRisk: 14 };
function isStale(lastUpdated: number | undefined, kind: keyof typeof STALE_DAYS): boolean {
  if (!lastUpdated || lastUpdated <= 0) return true;
  return Date.now() - lastUpdated > STALE_DAYS[kind] * DAY;
}
const nonEmpty = (v?: string): boolean => !!(v && String(v).trim());
/** §28: missing both (nextAction+owner+date) and (waitingFor+reviewDate). */
function needsNextAction(r: { nextAction?: string; nextActionOwner?: string; nextActionDate?: string }): boolean {
  return !(nonEmpty(r.nextAction) && nonEmpty(r.nextActionDate));
}

const TERMINAL_OPP = /won|lost|hold/i;
const OPEN_RISK = /open|monitoring/i;
const RESOLVED_RISK = /closed|mitigated|accepted|resolved/i;

export function renderCommandOps(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
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
  const activeProjects = projects.filter(projectIsActive);

  // ── PANEL 1 · NEEDS ATTENTION ──
  const overdueTasks = openTasks.filter(isOverdue).sort((a, b) => (Date.parse(a.dueDate || "") || 0) - (Date.parse(b.dueDate || "") || 0));
  const blockedProjects = activeProjects.filter((p) => tasks.some((t) => t.projectId === p.id && !isDone(t) && isBlocked(t)));
  const missingOwnerTasks = openTasks.filter((t) => !nonEmpty(t.assignee) && (t.status === "in_progress" || t.status === "todo"));
  const missingOwnerObjects = [
    ...O.opportunities.filter((o) => !nonEmpty(o.owner) && !TERMINAL_OPP.test(o.stage || "")).map((o) => ({ title: o.name, kind: "opportunity" })),
    ...O.risks.filter((r) => !nonEmpty(r.owner) && !RESOLVED_RISK.test(r.status || "")).map((r) => ({ title: r.title, kind: "risk" })),
    ...O.commitments.filter((c) => !nonEmpty(c.owner)).map((c) => ({ title: c.name, kind: "commitment" })),
  ];
  const missingNextAction = [
    ...O.opportunities.filter((o) => !TERMINAL_OPP.test(o.stage || "") && (o.needsAction || needsNextAction(o))).map((o) => ({ title: o.name, kind: "opportunity" })),
    ...O.risks.filter((r) => OPEN_RISK.test(r.status || "") && needsNextAction(r)).map((r) => ({ title: r.title, kind: "risk" })),
  ];
  const clientFollowUps = O.clients.filter((c) => /prospect|follow|nurtur|churn/i.test(`${c.status || ""} ${c.pipelineStatus || ""}`));
  const upcomingDeadlines = openTasks.filter((t) => dueWithinDays(t, 7) && !isOverdue(t)).sort((a, b) => (Date.parse(a.dueDate || "") || 0) - (Date.parse(b.dueDate || "") || 0));
  const outstandingInvoices = O.commitments.filter((c) => /money in/i.test(c.direction || "") && (isOverdueCommitment(c) || /invoiced|expected|partially/i.test(c.status || "")));
  const unresolvedRisks = O.risks.filter((r) => OPEN_RISK.test(r.status || ""));
  const decisionsAwaitingPrep = O.decisions.filter((d) => /preparing/i.test(d.status || ""));

  const attnCount = overdueTasks.length + blockedProjects.length + missingOwnerTasks.length + missingOwnerObjects.length
    + missingNextAction.length + clientFollowUps.length + upcomingDeadlines.length + outstandingInvoices.length
    + unresolvedRisks.length + decisionsAwaitingPrep.length;

  // ── PANEL 2 · PORTFOLIO ──
  const activeOpps = O.opportunities.filter((o) => !TERMINAL_OPP.test(o.stage || o.status || ""));

  // ── PANEL 3 · WORKLOAD (work by owner, derived like person.workloadFor) ──
  const byOwner = new Map<string, { active: number; total: number }>();
  for (const t of openTasks) {
    const owner = nonEmpty(t.assignee) ? t.assignee! : "· Unassigned";
    const rec = byOwner.get(owner) || { active: 0, total: 0 };
    rec.total += 1;
    if (t.status === "in_progress") rec.active += 1;
    byOwner.set(owner, rec);
  }
  const workByOwner = [...byOwner.entries()]
    .filter(([o]) => o !== "· Unassigned")
    .sort((a, b) => b[1].total - a[1].total);
  const unassigned = byOwner.get("· Unassigned")?.total || 0;
  const founder = O.people.find((p) => /founder|owner|ceo|principal/i.test(`${p.role || ""} ${p.relationshipType || ""}`));
  const founderName = founder?.name || (workByOwner[0]?.[0] ?? "");
  // Match the founder to a work-by-owner bucket robustly: an exact assignee
  // match first, else a shared-name-token match ("Marcus (Founder)" ↔ "Marcus"),
  // since person.name and a task's assignee string won't always be identical.
  const nameTokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const founderTokens = nameTokens(founderName);
  const founderKey = byOwner.has(founderName)
    ? founderName
    : [...byOwner.keys()].find((k) => k !== "· Unassigned" && [...nameTokens(k)].some((tk) => founderTokens.has(tk)));
  const founderLoad = founderKey ? byOwner.get(founderKey) : undefined;
  const founderLabel = founderKey && founderKey !== founderName ? `${founderName} · ${founderKey}` : founderName;

  // ── PANEL 4 · SYSTEM QUALITY ──
  const staleRecords = [
    ...O.opportunities.filter((o) => isStale(o.lastUpdated, "opportunity")).map((o) => ({ title: o.name, kind: "opportunity" })),
    ...O.risks.filter((r) => isStale(r.lastUpdated, (r.riskScore || 0) >= 12 ? "criticalRisk" : "normalRisk")).map((r) => ({ title: r.title, kind: "risk" })),
    ...activeProjects.filter((p) => isStale(p.updatedAt, "project")).map((p) => ({ title: p.name, kind: "project" })),
  ];
  const projectsNoNextAction = activeProjects.filter((p) => !tasks.some((t) => t.projectId === p.id && !isDone(t) && (t.status === "todo" || t.status === "in_progress")));
  const oppsNoFollowUp = O.opportunities.filter((o) => !TERMINAL_OPP.test(o.stage || "") && (o.needsAction || needsNextAction(o)));
  const risksNoOwner = O.risks.filter((r) => !nonEmpty(r.owner) && !RESOLVED_RISK.test(r.status || ""));
  const decisionsPastDeadline = O.decisions.filter((d) => isoIsPast(d.decisionDeadline) && !/decided|cancelled/i.test(d.status || ""));

  const sysCount = staleRecords.length + projectsNoNextAction.length + oppsNoFollowUp.length + risksNoOwner.length + decisionsPastDeadline.length;

  const lastUpdated = state.kanbanRefreshing || O.loading
    ? "syncing…"
    : `${projects.length} projects · ${tasks.length} tasks${O.anyServed ? " · live objects" : " · restart gateway to serve object stores"}`;

  return html`
    <div class="kis cc ba-glass">
      ${baAurora()}
      ${CC_STYLE}
      <header class="cc-header" data-learn-id="ops-header">
        <div>
          <div class="cc-eyebrow">Operations Command Center</div>
          <h1 class="cc-h1">Run the <span class="bag-gold-text">organization.</span></h1>
          <p class="cc-lede">Broad visibility across everything that is happening. This dashboard manages the organization; the Executive dashboard keeps the CEO focused on decisions.</p>
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

      ${bandLabel("Operating Snapshot", "The four panels, summarised.", "gold")}
      <div class="cc-metrics">
        ${metric("Needs attention", attnCount, attnCount ? "danger" : "ok", "open loops right now")}
        ${metric("Overdue", loading ? "—" : overdueTasks.length, loading ? "muted" : overdueTasks.length ? "danger" : "ok", loading ? "board not responding" : "tasks past their date")}
        ${metric("Blocked projects", loading ? "—" : blockedProjects.length, loading ? "muted" : blockedProjects.length ? "danger" : "ok", loading ? "board not responding" : "delivery stopped")}
        ${metric("Unowned records", missingOwnerTasks.length + missingOwnerObjects.length, missingOwnerTasks.length + missingOwnerObjects.length ? "warn" : "ok", "no accountable owner")}
        ${metric("Active projects", loading ? "—" : activeProjects.length, loading ? "muted" : "gold", loading ? "board not responding" : `${projects.length} total`)}
        ${metric("Open opportunities", activeOpps.length, "gold", money(activeOpps.reduce((s2, o) => s2 + (Number(o.estimatedValue) || 0), 0)))}
        ${metric("Unassigned work", loading ? "—" : unassigned, loading ? "muted" : unassigned ? "warn" : "ok", loading ? "board not responding" : "open tasks with no owner")}
        ${metric("Data quality", sysCount, sysCount ? "warn" : "ok", "records needing maintenance")}
      </div>

      ${bandLabel("Full Visibility", "Everything that is happening, by panel.", "info")}
      <div class="cc-grid-2">
        <!-- PANEL 1 · NEEDS ATTENTION -->
        ${panel("Needs Attention", "Everything with an open loop right now.", html`
          ${listBlock("Overdue tasks", overdueTasks.length,
            overdueTasks.slice(0, 5).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip(fmtDue(t), "danger"), prioChip(t.priority)], "danger")), "danger", "No overdue tasks.")}
          ${listBlock("Blocked projects", blockedProjects.length,
            blockedProjects.slice(0, 4).map((p) => row(p.name, `${(p.assignedInstances && p.assignedInstances[0]) || "unassigned"}`, [chip("blocked", "danger")], "danger")), "danger", "No blocked projects.")}
          ${listBlock("Missing owners", missingOwnerTasks.length + missingOwnerObjects.length,
            [...missingOwnerObjects.slice(0, 3).map((o) => row(o.title, o.kind, [chip("no owner", "warn")], "warn")),
             ...missingOwnerTasks.slice(0, 2).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip("no owner", "warn")], "warn"))], "warn", "Everything is owned.")}
          ${listBlock("Missing next actions", missingNextAction.length,
            missingNextAction.slice(0, 4).map((o) => row(o.title, o.kind, [chip("no next action", "warn")], "warn")), "warn", "All records have a next action.")}
          ${listBlock("Client follow-ups", clientFollowUps.length,
            clientFollowUps.slice(0, 4).map((c) => row(c.name, c.pipelineStatus || c.status, [chip("follow up", "gold")], "gold")), "gold", "No client follow-ups pending.")}
          ${listBlock("Upcoming deadlines (7d)", upcomingDeadlines.length,
            upcomingDeadlines.slice(0, 4).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip(fmtDue(t), "gold")], "gold")), "gold", "Nothing due in the next 7 days.")}
          ${listBlock("Outstanding invoices", outstandingInvoices.length,
            outstandingInvoices.slice(0, 4).map((c) => row(c.name, c.owner || c.direction, [chip(money(c.remainingBalance ?? c.amount), "warn"), isOverdueCommitment(c) ? chip("overdue", "danger") : nothing], "warn")), "warn", "No outstanding invoices.")}
          ${listBlock("Unresolved risks", unresolvedRisks.length,
            unresolvedRisks.slice(0, 4).map((r) => row(r.title, `${r.category || "risk"}${r.owner ? ` · ${r.owner}` : ""}`, [r.riskScore ? chip(`score ${r.riskScore}`, r.riskScore >= 12 ? "danger" : "warn") : nothing], r.riskScore >= 12 ? "danger" : "warn")), "warn", "No unresolved risks.")}
          ${listBlock("Decisions awaiting preparation", decisionsAwaitingPrep.length,
            decisionsAwaitingPrep.slice(0, 4).map((d) => row(d.title, d.owner || d.decisionType || "", [chip("prep", "muted")], "muted")), "muted", "No decisions awaiting prep.")}
        `, { count: attnCount, countTone: attnCount ? "danger" : "ok", iconName: "alert" })}

        <!-- PANEL 2 · PORTFOLIO -->
        ${panel("Portfolio", "Everything you own, at a glance.", html`
          ${listBlock("All projects", projects.length,
            [...projects].sort((a, b) => (projectIsActive(b) ? 1 : 0) - (projectIsActive(a) ? 1 : 0)).slice(0, 6)
              .map((p) => row(p.name, p.status || "—", [projectIsActive(p) ? chip("active", "ok") : chip(p.status || "idle", "muted")], projectIsActive(p) ? "gold" : "muted")), "gold", "No projects.")}
          ${listBlock("All opportunities", O.opportunities.length,
            [...activeOpps].sort((a, b) => (b.estimatedValue || 0) - (a.estimatedValue || 0)).slice(0, 5)
              .map((o) => row(o.name, o.stage || o.status || "New", [o.estimatedValue ? chip(money(o.estimatedValue), "gold") : nothing], "gold")), "gold",
            O.anyServed ? "No opportunities." : "Restart gateway to serve opportunity.list.")}
          ${listBlock("All clients", O.clients.length,
            O.clients.slice(0, 5).map((c) => row(c.name, c.pipelineStatus || c.status, [/active/i.test(c.status || "") ? chip("active", "ok") : chip(c.status || "—", "muted")], /active/i.test(c.status || "") ? "ok" : "muted")), "muted",
            O.anyServed ? "No clients." : "Restart gateway to serve clients.list.")}
          ${/* clients.list reads agency.db — the same client list as Business hub › Clients. */
          isTabAvailable("hub")
            ? html`<button type="button" class="bag-btn cc-hubbtn" @click=${() => openHubSection(state, "clients")}>
                Open clients in Business hub
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              </button>`
            : nothing}
          ${listBlock("Product status", O.products.length,
            O.products.slice(0, 5).map((p) => row(p.name, p.productType || "product", [/live|launched|shipped|ga/i.test(p.status || "") ? chip("live", "ok") : chip(p.status || "building", "gold")], "gold")), "gold",
            O.anyServed ? "No products." : "Restart gateway to serve product.list.")}
        `, { count: projects.length + O.opportunities.length + O.clients.length + O.products.length, countTone: "gold", iconName: "box" })}

        <!-- PANEL 3 · WORKLOAD -->
        ${panel("Workload", "Who is carrying what.", html`
          <div class="cc-block">
            <div class="cc-block-head">${chip("Founder workload", founderLoad ? "gold" : "muted")}</div>
            ${founderLoad
              ? row(founderLabel, `${founderLoad.active} active · ${founderLoad.total} open`, [chip(`${founderLoad.total} items`, founderLoad.total > 8 ? "danger" : "gold")], founderLoad.total > 8 ? "danger" : "gold")
              : emptyState("No founder identified — add a person with role Founder.")}
          </div>
          ${listBlock("Work by owner", workByOwner.length,
            workByOwner.slice(0, 8).map(([owner, l]) => row(owner, `${l.active} active`, [chip(`${l.total}`, l.total > 8 ? "danger" : l.total > 4 ? "warn" : "muted")], l.total > 8 ? "danger" : "gold")), "gold", "No assigned work.")}
          <div class="cc-block">
            <div class="cc-block-head">${chip("Unassigned work", unassigned ? "warn" : "ok")} <span class="cc-block-n cc-block-n--${unassigned ? "warn" : "muted"}">${unassigned}</span></div>
            ${unassigned
              ? html`<div class="cc-block-rows">${openTasks.filter((t) => !nonEmpty(t.assignee)).slice(0, 5).map((t) => row(t.title || "Untitled", projectName(projects, t.projectId), [chip("unassigned", "warn")], "warn"))}</div>`
              : emptyState("All open work is assigned.")}
          </div>
        `, { count: byOwner.size, countTone: "gold", iconName: "user" })}

        <!-- PANEL 4 · SYSTEM QUALITY -->
        ${panel("System Quality", "Where the records themselves need maintenance.", html`
          ${listBlock("Records not updated", staleRecords.length,
            staleRecords.slice(0, 5).map((r) => row(r.title, r.kind, [chip("stale", "warn")], "warn")), "warn", "All records are fresh.")}
          ${listBlock("Projects without next action", projectsNoNextAction.length,
            projectsNoNextAction.slice(0, 5).map((p) => row(p.name, p.status || "active", [chip("no next action", "warn")], "warn")), "warn", "Every active project has a next action.")}
          ${listBlock("Opportunities without follow-up", oppsNoFollowUp.length,
            oppsNoFollowUp.slice(0, 5).map((o) => row(o.name, o.stage || "—", [chip("no follow-up", "warn")], "warn")), "warn", "Every opportunity has a follow-up.")}
          ${listBlock("Risks without owners", risksNoOwner.length,
            risksNoOwner.slice(0, 5).map((r) => row(r.title, r.category || "risk", [chip("no owner", "danger")], "danger")), "danger", "Every risk has an owner.")}
          ${listBlock("Decisions past deadline", decisionsPastDeadline.length,
            decisionsPastDeadline.slice(0, 5).map((d) => row(d.title, d.owner || d.decisionType || "", [chip(fmtIsoDue(d.decisionDeadline), "danger")], "danger")), "danger", "No decisions past deadline.")}
        `, { count: sysCount, countTone: sysCount ? "warn" : "ok", iconName: "shield" })}
      </div>

      <footer class="cc-footer">
        Operations Command Center · KIS Phase 1 · full-visibility operating view — derived live from the board + object stores.
      </footer>
    </div>
  `;
}

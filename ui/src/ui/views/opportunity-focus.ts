/**
 * Opportunity focus page — the full, Notion-shaped detail view for one
 * opportunity (Business Control Layer, Object 2).
 *
 * Reads top-to-bottom the way a Notion page does:
 *   cover banner → title + headline chips → pipeline progress rail →
 *   properties grid → next-action block → body sections → links → Related graph.
 *
 * Deliberately a SEPARATE module from the pipeline board (views/opportunity.ts):
 * the board keeps owning the kanban + create/edit modal, and this file owns the
 * focus layout. Other agents extending the detail surface (e.g. a Reports
 * section) can append a cohesive block here without touching the board.
 *
 * State lives in controllers/opportunity.ts (`focusId`); this module is
 * presentation only.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { renderRelatedPanel } from "../components/related-panel";
import "../components/people-chips";
import { renderCoverBanner } from "../components/object-cover";
import {
  PIPELINE_STAGES,
  PRIORITY_LABELS,
  closeFocus,
  deleteOpportunity,
  moveStage,
  openEdit,
  type Opportunity,
} from "../controllers/opportunity";
import { icon } from "./kis-shared";

// ═══════════════════════════════════════════════════════════════════
// LINKED-OBJECT NAME RESOLUTION
// ═══════════════════════════════════════════════════════════════════

/**
 * The opportunity stores raw ids for its client / product / project links. A
 * focus page that renders `a3f9c1…` teaches nobody anything, so resolve the
 * names once per session (three cheap list calls, cached module-side) and fall
 * back to the id when a lookup is unavailable.
 */
const nameMaps: Record<string, Map<string, string>> = {
  client: new Map(),
  product: new Map(),
  project: new Map(),
};
const nameLoaded = new Set<string>();

function loadNames(app: AppViewState, client: GatewayBrowserClient, kind: string) {
  if (nameLoaded.has(kind)) return;
  nameLoaded.add(kind);
  void (async () => {
    try {
      let rows: Array<Record<string, unknown>> = [];
      if (kind === "client") {
        const res = (await client.request("clients.list", {})) as { clients?: unknown[] };
        rows = (res?.clients ?? []) as Array<Record<string, unknown>>;
      } else if (kind === "product") {
        const res = (await client.request("product.list", {})) as { products?: unknown[] };
        rows = (res?.products ?? []) as Array<Record<string, unknown>>;
      } else {
        const res = (await client.request("projects.list", {})) as { projects?: unknown[] };
        rows = (res?.projects ?? []) as Array<Record<string, unknown>>;
      }
      const map = nameMaps[kind];
      for (const r of rows) {
        const id = String(r.id ?? "");
        const name = String(r.name ?? r.title ?? r.company ?? "");
        if (id && name) map.set(id, name);
      }
      app.requestUpdate?.();
    } catch {
      // New/unserved RPC or an empty surface — chips fall back to the raw id.
      nameLoaded.delete(kind);
    }
  })();
}

function resolveName(
  app: AppViewState,
  client: GatewayBrowserClient,
  kind: "client" | "product" | "project",
  id: string,
): string {
  if (!id) return "";
  loadNames(app, client, kind);
  return nameMaps[kind].get(id) || "";
}

// ═══════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════

function fmtMoney(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `$${v.toLocaleString()}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "in 12 days" / "9 days ago" — the bit that makes a close date actionable. */
function relativeDays(iso: string): { label: string; overdue: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return { label: "today", overdue: false };
  if (days > 0) return { label: `in ${days} day${days === 1 ? "" : "s"}`, overdue: false };
  return { label: `${-days} day${days === -1 ? "" : "s"} ago`, overdue: true };
}

/** Stage tone as a CSS value (tokens, so light theme follows). Shared with the board. */
export function stageTone(stage: string): string {
  switch (stage) {
    case "Won":
      return "var(--wgk-ok)";
    case "Lost":
      return "var(--wgk-danger)";
    case "Hold":
      return "var(--wgk-muted)";
    case "Negotiation":
    case "Proposal":
      return "var(--wgk-warn)";
    default:
      return "var(--glass-gold)";
  }
}

export function priorityTone(p: string): string {
  switch (String(p).toUpperCase()) {
    case "P0":
      return "var(--wgk-danger)";
    case "P1":
      return "var(--wgk-warn)";
    case "P2":
      return "var(--glass-gold)";
    default:
      return "var(--wgk-muted)";
  }
}

function scoreTone(score: number): string {
  const n = Number(score) || 0;
  if (n >= 80) return "var(--wgk-ok)";
  if (n >= 55) return "var(--glass-gold)";
  if (n >= 30) return "var(--wgk-warn)";
  return "var(--wgk-danger)";
}

// ═══════════════════════════════════════════════════════════════════
// NETWORK CONTEXT (My Network — who is involved and how to reach them)
// ═══════════════════════════════════════════════════════════════════

interface OppNetworkContext {
  people: Array<{
    contactId: string;
    name: string;
    via: string;
    role?: string;
    relationshipValue: number;
    path: { found: boolean; description: string; minStrength: number };
  }>;
  connections: Array<{ connectionId: string; between: [string, string]; relationshipType: string; strength: number }>;
}

const networkCtx = new Map<string, { at: number; data: OppNetworkContext | null; error?: string }>();
const networkInflight = new Set<string>();

function ensureNetworkContext(app: AppViewState, client: GatewayBrowserClient, oppId: string): void {
  const hit = networkCtx.get(oppId);
  if ((hit && Date.now() - hit.at < 30_000) || networkInflight.has(oppId)) return;
  networkInflight.add(oppId);
  void client
    .request("network.context", { opportunityId: oppId })
    .then((r) => networkCtx.set(oppId, { at: Date.now(), data: r as OppNetworkContext }))
    .catch((e: unknown) => networkCtx.set(oppId, { at: Date.now(), data: null, error: String(e instanceof Error ? e.message : e) }))
    .finally(() => {
      networkInflight.delete(oppId);
      app.requestUpdate?.();
    });
}

function renderNetworkCard(app: AppViewState, client: GatewayBrowserClient, opp: Opportunity): TemplateResult {
  ensureNetworkContext(app, client, opp.id);
  const ctx = networkCtx.get(opp.id);
  const openNetwork = (id?: string) => {
    void import("../controllers/people-network").then((m) => {
      m.networkState.selectedId = id ?? null;
      m.networkState.detail = null;
      m.networkState.loaded = false;
      app.setTab("people-network");
    });
  };
  return html`
    <div class="wgf-card">
      ${sectionTitle("Network — who's involved", "people, value and the warm path from you")}
      <ib-people-chips style="margin:2px 0 8px" .client=${client} objectType="opportunity" objectId=${opp.id}></ib-people-chips>
      ${!ctx
        ? html`<div class="wg-skel" style="height:34px"></div>`
        : !ctx.data
          ? html`<p class="wgf-muted">Network unavailable${ctx.error ? ` — ${ctx.error}` : ""}.</p>`
          : !ctx.data.people.length && !ctx.data.connections.length
            ? html`<p class="wgf-muted">No one in your network is linked to this deal yet.
                <button class="wgk-btn wgk-btn--sm" @click=${() => openNetwork()}>Open My Network</button></p>`
            : html`
                ${ctx.data.people.map(
                  (p) => html`${prop(
                    p.name,
                    html`<button class="wgk-btn wgk-btn--sm" title="Open in My Network" @click=${() => openNetwork(p.contactId)}>
                        via ${p.via}${p.role ? ` · ${p.role}` : ""}
                      </button>
                      <span class="wgf-muted">${p.path.found ? ` ${p.path.description}` : " no warm path yet"}</span>`,
                  )}`,
                )}
                ${ctx.data.connections.map(
                  (c) => html`${prop("Carried by", `${c.between[0]} ↔ ${c.between[1]} (${c.relationshipType}, ${c.strength}/5)`)}`,
                )}
              `}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// BUILDING BLOCKS
// ═══════════════════════════════════════════════════════════════════

const backGlyph = html`<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>`;
const calGlyph = html`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" /></svg>`;

function sectionTitle(title: string, hint?: string): TemplateResult {
  return html`
    <div class="wgf-sec">
      <span class="wgf-sec__t">${title}</span>
      ${hint ? html`<span class="wgf-sec__h">${hint}</span>` : nothing}
    </div>
  `;
}

/** A Notion-style property row: muted label, value that can breathe. */
function prop(label: string, value: unknown, opts: { dim?: boolean } = {}): TemplateResult {
  const empty = value === null || value === undefined || value === "" || value === 0;
  return html`
    <div class="wgf-prop">
      <span class="wgf-prop__k">${label}</span>
      <span class="wgf-prop__v ${empty || opts.dim ? "is-dim" : ""}">${empty ? html`<span class="wgf-none">—</span>` : value}</span>
    </div>
  `;
}

/** A link chip for a linked object: resolved name up front, short id behind it. */
function linkChip(kind: string, name: string, id: string): TemplateResult {
  return html`
    <span class="wgf-link" title=${`${kind}:${id}`}>
      ${icon("link", 11)}
      <b>${name || kind}</b>
      <span class="wgf-link__id">${id.length > 10 ? `${id.slice(0, 8)}…` : id}</span>
    </span>
  `;
}

function headlineChip(label: string, value: string, tone: string): TemplateResult {
  return html`
    <span class="wgf-hchip" style="--tone:${tone}">
      <span class="wgf-hchip__k">${label}</span>
      <b>${value}</b>
    </span>
  `;
}

/**
 * The pipeline progress rail. Every non-terminal stage is a clickable step, so
 * the focus page can advance the deal without bouncing back to the board; the
 * current stage is filled, everything before it is dimmed-complete.
 */
function renderStageRail(
  app: AppViewState,
  client: GatewayBrowserClient,
  opp: Opportunity,
): TemplateResult {
  const active = PIPELINE_STAGES.filter((s) => !["Won", "Lost", "Hold"].includes(s));
  const terminal = ["Won", "Lost", "Hold"] as const;
  const idx = active.indexOf(opp.stage as (typeof active)[number]);
  const isTerminal = terminal.includes(opp.stage as (typeof terminal)[number]);
  const pct = isTerminal ? 100 : idx < 0 ? 0 : (idx / (active.length - 1)) * 100;

  const step = (stage: string, i: number) => {
    const done = !isTerminal && idx >= 0 && i < idx;
    const current = stage === opp.stage;
    return html`
      <button
        class="wgf-step ${current ? "is-current" : ""} ${done ? "is-done" : ""}"
        style="--tone:${stageTone(stage)}"
        title=${`Move to ${stage}`}
        aria-current=${current ? "step" : nothing}
        @click=${() => void moveStage(app, client, opp, stage)}
      >
        <span class="wgf-step__dot"></span>
        <span class="wgf-step__l">${stage}</span>
      </button>
    `;
  };

  return html`
    <div class="wgf-card">
      ${sectionTitle("Pipeline Stage", isTerminal ? `terminal — ${opp.stage}` : `${idx + 1} of ${active.length}`)}
      <div class="wgf-rail">
        <div class="wgf-rail__track"></div>
        <div class="wgf-rail__fill" style="width:${pct}%"></div>
        <div class="wgf-rail__steps">${active.map((s, i) => step(s, i))}</div>
      </div>
      <div class="wgf-terminal">
        ${terminal.map(
          (t) => html`<button
            class="wgf-tbtn ${opp.stage === t ? "is-on" : ""}"
            style="--tone:${stageTone(t)}"
            aria-pressed=${String(opp.stage === t)}
            @click=${() => void moveStage(app, client, opp, t)}
          >${t}</button>`,
        )}
      </div>
    </div>
  `;
}

/** Next Action (§28) — action + owner + date, or the Waiting-For alternative. */
function renderNextAction(opp: Opportunity): TemplateResult {
  const hasAction = Boolean(opp.nextAction?.trim());
  const hasWaiting = Boolean(opp.waitingFor?.trim());
  const rel = relativeDays(hasAction ? opp.nextActionDate || "" : opp.reviewDate || "");

  if (!hasAction && !hasWaiting) {
    return html`
      <div class="wgf-card wgf-card--warn">
        ${sectionTitle("Next Action", "§28")}
        <div class="wgf-warnline">
          ${icon("alert", 13)}<span>No next action and nothing being waited on — this opportunity has no forward motion.</span>
        </div>
      </div>
    `;
  }

  return html`
    <div class="wgf-card">
      ${sectionTitle("Next Action", "§28")}
      <div class="wgf-next">
        ${hasAction
          ? html`<span class="wgf-next__k">Next</span>${opp.nextAction}`
          : html`<span class="wgf-next__k">Waiting for</span>${opp.waitingFor}`}
      </div>
      <div class="wgf-next__meta">
        ${hasAction && opp.nextActionOwner
          ? html`<span>${icon("user", 12)}<b>${opp.nextActionOwner}</b></span>`
          : nothing}
        ${rel
          ? html`<span>
              ${calGlyph}<b>${fmtDate(hasAction ? opp.nextActionDate || "" : opp.reviewDate)}</b>
              <span class=${rel.overdue ? "wgf-late" : "wgf-muted"}>· ${rel.label}</span>
            </span>`
          : nothing}
      </div>
    </div>
  `;
}

/** A long-form body section (problem / solution / notes). */
function renderBody(title: string, text: string, hint?: string): TemplateResult {
  return html`
    <div class="wgf-card">
      ${sectionTitle(title, hint)}
      ${text?.trim()
        ? html`<div class="wgf-body">${text}</div>`
        : html`<div class="wgf-body is-empty">Not captured yet.</div>`}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

export function renderOpportunityFocus(
  app: AppViewState,
  client: GatewayBrowserClient,
  opp: Opportunity,
): TemplateResult {
  const clientName = resolveName(app, client, "client", opp.clientId || "");
  const productName = resolveName(app, client, "product", opp.productId || "");
  const projectName = resolveName(app, client, "project", opp.projectId || "");
  const close = relativeDays(opp.expectedCloseDate);
  const prioLabel = PRIORITY_LABELS[String(opp.priority).toUpperCase()] ?? opp.priority;

  const titleOverlay = html`
    <div class="wgf-overlay">
      <div class="wgf-overlay__eyebrow">
        <span>Opportunity</span>
        ${opp.opportunityType ? html`<span class="wgf-sep">·</span><span>${opp.opportunityType}</span>` : nothing}
        ${opp.ceoRequired ? html`<span class="wgf-sep">·</span><span class="wgf-ceo">${icon("star", 10)} CEO required</span>` : nothing}
      </div>
      <h1 class="wgf-overlay__title">${opp.name || "(untitled opportunity)"}</h1>
      <div class="wgf-overlay__chips">
        ${headlineChip("Stage", opp.stage || "—", stageTone(opp.stage))}
        ${headlineChip("Value", fmtMoney(opp.estimatedValue), "var(--glass-gold-hi)")}
        ${headlineChip("Score", String(opp.opportunityScore || 0), scoreTone(opp.opportunityScore))}
        ${headlineChip("Priority", prioLabel ?? "—", priorityTone(opp.priority))}
        ${opp.owner
          ? headlineChip("Owner", opp.owner, "#fff")
          : headlineChip("Owner", "unassigned", "var(--wgk-danger)")}
      </div>
    </div>
  `;

  return html`
    <div class="wgf">
      <div class="wgf__inner">
        <!-- Toolbar (above the cover, like a Notion page's breadcrumb bar) -->
        <div class="wgf-toolbar">
          <button class="wgk-btn wgk-btn--sm" @click=${() => closeFocus(app)}>${backGlyph}<span>Pipeline</span></button>
          <div class="wgf-toolbar__end">
            ${opp.proposalLink
              ? html`<a class="wgk-btn wgk-btn--sm wgf-gold" href=${opp.proposalLink} target="_blank" rel="noreferrer noopener">Proposal ↗</a>`
              : nothing}
            <button class="wgk-btn wgk-btn--sm" @click=${() => openEdit(app, opp)}>Edit</button>
            <button
              class="wgk-btn wgk-btn--sm wgk-btn--danger"
              @click=${() => {
                void deleteOpportunity(app, client, opp.id);
                closeFocus(app);
              }}
            >${icon("trash", 12)}<span>Delete</span></button>
          </div>
        </div>

        <!-- Cover banner + title block -->
        <div class="wgf-cover">
          ${renderCoverBanner(app, client, "opportunity", opp.id, {
            height: 232,
            seed: opp.id || opp.name,
            overlay: titleOverlay,
            radius: "20px",
          })}
        </div>

        <!-- Flags -->
        ${opp.needsAction || opp.stale || opp.blocked || opp.escalationRequired
          ? html`<div class="wgf-flags">
              ${opp.needsAction ? html`<span class="wgf-flag" style="--tone:var(--wgk-warn)">${icon("alert", 11)}needs a next action</span>` : nothing}
              ${opp.stale ? html`<span class="wgf-flag" style="--tone:var(--wgk-danger)">${icon("clock", 11)}stale — untouched 7+ days</span>` : nothing}
              ${opp.blocked ? html`<span class="wgf-flag" style="--tone:var(--wgk-danger)">${icon("x", 11)}blocked${opp.blocker ? `: ${opp.blocker}` : ""}</span>` : nothing}
              ${opp.escalationRequired ? html`<span class="wgf-flag" style="--tone:var(--glass-gold)">${icon("arrowUp", 11)}escalation required</span>` : nothing}
            </div>`
          : nothing}

        <!-- Stage rail -->
        ${renderStageRail(app, client, opp)}

        <!-- Properties + commercials, side by side -->
        <div class="wgf-split">
          <div class="wgf-card">
            ${sectionTitle("Properties")}
            ${prop("Client", opp.clientId ? linkChip("client", clientName, opp.clientId) : "")}
            ${prop("Owner", opp.owner)}
            ${prop("Supporting Owner", opp.supportingOwner)}
            ${prop("Type", opp.opportunityType)}
            ${prop("Status", opp.status)}
            ${prop("Priority", html`<span class="wgf-tone" style="--tone:${priorityTone(opp.priority)}">${prioLabel}</span>`)}
            ${prop("Product", opp.productId ? linkChip("product", productName, opp.productId) : "")}
            ${prop("Project", opp.projectId ? linkChip("project", projectName, opp.projectId) : "")}
            ${prop("Data Quality (§35)", opp.dataQuality)}
            ${prop("Authority Level (§32)", opp.authorityLevel)}
          </div>

          <div class="wgf-col">
            <div class="wgf-card">
              ${sectionTitle("Commercials")}
              <div class="wgf-money">
                <span class="wgf-money__v">${fmtMoney(opp.estimatedValue)}</span>
                <span class="wgf-muted">${opp.revenueType || "revenue type unset"}</span>
              </div>
              ${prop("Opportunity Score", html`<span class="wgf-tone wgf-strong" style="--tone:${scoreTone(opp.opportunityScore)}">◆ ${opp.opportunityScore || 0}</span>`)}
              ${prop(
                "Expected Close",
                opp.expectedCloseDate
                  ? html`${fmtDate(opp.expectedCloseDate)}
                      ${close ? html`<span class=${close.overdue ? "wgf-late" : "wgf-muted"}> · ${close.label}</span>` : nothing}`
                  : "",
              )}
              ${prop("Revenue Type", opp.revenueType)}
              ${prop(
                "Proposal",
                opp.proposalLink
                  ? html`<a class="wgf-a" href=${opp.proposalLink} target="_blank" rel="noreferrer noopener">${opp.proposalLink}</a>`
                  : "",
              )}
            </div>
            ${renderNextAction(opp)}
          </div>
        </div>

        <!-- Body sections -->
        ${renderBody("Problem / Need", opp.problemNeed || "", "what the customer is trying to solve")}
        ${renderBody("Proposed Solution", opp.proposedSolution || "", "the product or approach on the table")}
        ${renderBody("Notes", opp.notes || "")}

        <!-- My Network: people involved, relationship value, warm intro path -->
        ${renderNetworkCard(app, client, opp)}

        <!-- Related graph (decisions / risks / people / commitments) -->
        <div class="wgf-card wgf-card--related">
          ${renderRelatedPanel(app, client, "opportunity", opp.id, {
            title: "Related — Client · Product · Project · Decisions · Risks",
          })}
        </div>

        <div class="wgf-stamp">
          created ${fmtDate(new Date(opp.createdAt).toISOString())} · updated
          ${fmtDate(new Date(opp.updatedAt).toISOString())}
        </div>
      </div>
    </div>
  `;
}

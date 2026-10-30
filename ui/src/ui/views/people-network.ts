/**
 * My Network (People Network) page — /people-network.
 *
 * The owner at the centre of an interactive relationship graph (or a table),
 * with filters, a side panel for the selected person (value list, open
 * opportunities with stage, warm-intro path, next action, change history) and
 * the add-contact / add-from-clients / connect / link-opportunity flows, the
 * warm score (ring layout + breakdown) and cross-object links (projects, notes,
 * tasks, files… linked to a person or a connection).
 * Presentation only — state + gateway calls live in controllers/people-network.
 *
 * Not to be confused with views/network.ts (the federation "Infinibot
 * Network" of instances).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import "../components/people-network-graph";
import {
  CONNECTION_DIRECTIONS,
  CONNECTION_STATUSES,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  ME_ID,
  RELATIONSHIP_TYPES,
  VALUE_TYPES,
  clearFilters,
  closeModal,
  deleteConnection,
  deleteContact,
  filteredNodes,
  filtersActive,
  fmtMoney,
  knownTags,
  loadNetwork,
  networkState as state,
  openAddContact,
  openClientPicker,
  openConnect,
  openEditConnection,
  openEditContact,
  openLinkOpportunity,
  promoteClient,
  saveConnection,
  saveContact,
  saveLink,
  searchClients,
  selectNode,
  setContactStatus,
  touchContact,
  typeColor,
  unlinkOpportunity,
  WARM_BANDS,
  WARM_FACTORS,
  bandLabel,
  closeLinkPicker,
  linkedObjectOptions,
  LINKABLE_TYPES,
  openLinkPicker,
  removeObjectLink,
  satellitesFor,
  saveObjectLink,
  setLinkPickerQuery,
  setWarmOverride,
  type LinkedGroup,
  type ConnectionDraft,
  type ContactDraft,
  type NetworkEdge,
  type NetworkNode,
  type NetworkOpportunity,
} from "../controllers/people-network";
import { icon } from "./kis-shared";
import { OBJECT_TYPE_LABEL, OBJECT_TYPE_PLURAL, openObject } from "../lib/object-routes";
import { openFocus as openOpportunityFocus } from "../controllers/opportunity";
import { wgAurora, wgEmpty, wgHero, wgStat } from "./work-glass";
import { wgkField, wgkModal, wgkSection, wgkSelect } from "./work-glass/kis-form";
import "./work-glass/people-network.css";

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

const STALE_OPTIONS: Array<[number, string]> = [
  [0, "Any last touch"],
  [14, "Stale > 14 days"],
  [30, "Stale > 30 days"],
  [60, "Stale > 60 days"],
  [90, "Stale > 90 days"],
];

function stageTone(stage: string): string {
  switch (stage) {
    case "Won":
      return "#5ccf86";
    case "Lost":
      return "#e05a4f";
    case "Hold":
      return "#8d9bb0";
    case "Negotiation":
    case "Proposal":
      return "var(--glass-gold-hi, #f1d38a)";
    default:
      return "var(--glass-gold, #d9b45f)";
  }
}

function strengthStars(n: number): TemplateResult {
  return html`<span class="pn-stars" aria-label=${`strength ${n} of 5`}>${[1, 2, 3, 4, 5].map((i) => html`<i class=${i <= n ? "on" : ""}></i>`)}</span>`;
}

function typeChip(t: string): TemplateResult {
  return html`<span class="pn-type" style="--tone:${typeColor(t)}">${t}</span>`;
}

function staleLabel(n: NetworkNode): TemplateResult | typeof nothing {
  if (n.staleDays === null) return html`<span class="pn-muted">never touched</span>`;
  const late = n.staleDays > 30;
  return html`<span class=${late ? "pn-late" : "pn-muted"}>${n.staleDays === 0 ? "today" : `${n.staleDays}d ago`}</span>`;
}

function nodeName(id: string): string {
  if (id === ME_ID) return state.graph?.me.label ?? "You";
  return state.graph?.nodes.find((n) => n.id === id)?.name ?? id;
}

function openLinked(app: AppViewState, type: string, id: string, label: string) {
  openObject(type, id, label, {
    basePath: (app as unknown as { basePath?: string }).basePath ?? "",
    onOpportunity: (oid) => openOpportunityFocus(app, oid),
  });
}

function trendChip(n: NetworkNode): TemplateResult | typeof nothing {
  if (n.warmTrend !== "warming" && n.warmTrend !== "cooling") return nothing;
  const up = n.warmTrend === "warming";
  return html`<span class="pn-trend ${up ? "up" : "down"}" title=${`vs about a week ago`}>${up ? "▲" : "▼"} ${n.warmDelta != null ? Math.abs(n.warmDelta) : ""} ${up ? "warming" : "cooling"}</span>`;
}

function warmPill(n: NetworkNode): TemplateResult {
  return html`<span class="pn-warm pn-warm--${n.warmBand}" title=${`Warm score ${n.warmScore}/100 · ${bandLabel(n.warmBand)}`}>${n.warmScore}</span>`;
}

/** Inline SVG sparkline of warm-score history (0-100). */
function sparkline(points: Array<{ score: number; at: number }>): TemplateResult | typeof nothing {
  if (points.length < 2) return nothing;
  const w = 120;
  const h = 28;
  const t0 = points[0].at;
  const span = Math.max(1, points[points.length - 1].at - t0);
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${(((p.at - t0) / span) * w).toFixed(1)},${(h - (p.score / 100) * h).toFixed(1)}`)
    .join(" ");
  return html`<svg class="pn-spark" viewBox="0 0 ${w} ${h}" width=${w} height=${h} aria-label="Warm score trend"><path d=${d}></path></svg>`;
}

function renderWarmSection(app: AppViewState, client: GatewayBrowserClient, node: NetworkNode): TemplateResult {
  const hist = state.detail && state.detailFor === node.id ? (state.detail.warmHistory ?? []) : [];
  const deg = Math.round((node.warmScore / 100) * 360);
  return html`<section class="pn-sec pn-warmsec" aria-label="Warm score">
    <div class="pn-warmhead">
      <div class="pn-dial pn-dial--${node.warmBand}" style="--deg:${deg}deg" role="img" aria-label=${`Warm score ${node.warmScore} of 100`}><b>${node.warmScore}</b><span>warm</span></div>
      <div class="pn-grow">
        <div class="pn-warmband">${bandLabel(node.warmBand)} ${trendChip(node)}</div>
        <div class="pn-muted">${node.warmOverridden ? html`Pinned by you · formula says <b>${node.warmComputed}</b>` : "Computed from the signals below"}</div>
        ${sparkline(hist)}
      </div>
    </div>
    <ul class="pn-factors">
      ${WARM_FACTORS.map((f) => {
        const v = node.warmBreakdown?.[f.key] ?? 0;
        return html`<li title=${f.hint}><span>${f.label}</span><i><em style="width:${Math.min(100, (v / f.max) * 100)}%"></em></i><b>${Math.round(v)}<small>/${f.max}</small></b></li>`;
      })}
    </ul>
    <div class="pn-override">
      <label><span>Pin score</span><input class="wgk-input" type="number" min="0" max="100" inputmode="numeric" aria-label="Override warm score (0-100)" placeholder=${String(node.warmComputed)} .value=${node.warmOverridden ? String(node.warmScore) : ""} @change=${(e: Event) => {
        const raw = (e.target as HTMLInputElement).value.trim();
        void setWarmOverride(app, client, node.id, raw === "" ? null : Math.max(0, Math.min(100, Math.round(Number(raw)))));
      }} /></label>
      ${node.warmOverridden ? html`<button class="wgk-btn wgk-btn--sm" @click=${() => setWarmOverride(app, client, node.id, null)}>Use formula</button>` : nothing}
    </div>
  </section>`;
}

/** "Linked" section: objects grouped by type with jump links, unlink and Link…. */
function renderLinkedSection(
  app: AppViewState,
  client: GatewayBrowserClient,
  kind: "contact" | "connection",
  id: string,
  title: string,
): TemplateResult {
  const slot = kind === "contact" ? state.linked : state.connLinked;
  const groups: LinkedGroup[] | null = slot && slot.id === id ? slot.groups : null;
  const total = groups?.reduce((n, g) => n + g.items.length, 0) ?? 0;
  return html`<section class="pn-sec pn-linked" aria-label="Linked">
    <div class="pn-sec__head"><h3>Linked${groups ? ` (${total})` : ""}</h3>
      <button class="wgk-btn wgk-btn--sm" @click=${() => openLinkPicker(app, client, kind, id, title)}>${icon("link", 11)}<span>Link…</span></button>
    </div>
    ${!groups
      ? html`<div class="wg-skel" style="height:34px"></div>`
      : !groups.length
        ? html`<p class="pn-muted">Link projects, notes, tasks, files, ideas or events to see them here — agents get them as context.</p>`
        : groups.map(
            (g) => html`<div class="pn-lgroup">
              <div class="pn-lgroup__h">${OBJECT_TYPE_PLURAL[g.type] ?? g.label}<b>${g.items.length}</b></div>
              <ul>${g.items.map(
                (it) => html`<li class="pn-litem ${it.resolved ? "" : "is-missing"}">
                  <span class="pn-lglyph" data-type=${it.type}>${(OBJECT_TYPE_LABEL[it.type] ?? it.type).charAt(0)}</span>
                  <button class="pn-litem__open" title=${`Open ${OBJECT_TYPE_LABEL[it.type] ?? it.type}`} @click=${() => openLinked(app, it.type, it.id, it.label)}>
                    <b>${it.label}</b><small>${[it.role, it.status, it.subtitle].filter(Boolean).join(" · ") || (it.resolved ? "" : "no longer exists")}</small>
                  </button>
                  <button class="pn-x" title="Unlink" aria-label=${`Unlink ${it.label}`} @click=${() => removeObjectLink(app, client, it, kind)}>${icon("x", 10)}</button>
                </li>`,
              )}</ul>
            </div>`,
          )}
  </section>`;
}

// ═══════════════════════════════════════════════════════════════════
// SIDE PANEL
// ═══════════════════════════════════════════════════════════════════

function renderOppRow(app: AppViewState, client: GatewayBrowserClient, o: NetworkOpportunity): TemplateResult {
  return html`<li class="pn-opp ${o.open ? "" : "is-closed"}">
    <div class="pn-opp__main">
      <span class="pn-opp__name">${o.name}</span>
      <span class="pn-stagechip" style="--tone:${stageTone(o.stage)}">${o.stage}</span>
    </div>
    <div class="pn-opp__meta">
      <span>${fmtMoney(o.estimatedValue)}</span>
      <span>via ${o.via}${o.role ? ` · ${o.role}` : ""}</span>
      ${o.nextAction ? html`<span class="pn-next">→ ${o.nextAction}${o.nextActionDate ? ` (${o.nextActionDate})` : ""}</span>` : nothing}
      ${o.via !== "client"
        ? html`<button class="pn-x" title="Unlink" aria-label=${`Unlink ${o.name}`} @click=${() => unlinkOpportunity(app, client, o)}>${icon("x", 10)}</button>`
        : html`<span class="pn-muted" title="Linked through the CRM client record">client deal</span>`}
    </div>
  </li>`;
}

function renderMePanel(app: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const g = state.graph!;
  const top = [...g.nodes]
    .sort((a, b) => b.relationshipValue + b.pipelineValue - (a.relationshipValue + a.pipelineValue))
    .slice(0, 6);
  const open = g.opportunities.filter((o) => o.open);
  return html`
    <div class="pn-panel__head">
      <div class="pn-avatar pn-avatar--me">YOU</div>
      <div>
        <div class="pn-panel__eyebrow">Your network</div>
        <h2 class="pn-panel__title">${g.me.label}</h2>
        <div class="pn-muted">${g.stats.contacts} ${g.stats.contacts === 1 ? "person" : "people"} · ${g.stats.connections} connection${g.stats.connections === 1 ? "" : "s"}</div>
      </div>
    </div>
    <section class="pn-sec">
      <h3>Warmth rings · avg ${g.stats.avgWarm ?? 0}</h3>
      <div class="pn-bands">${WARM_BANDS.map(
        (b) => html`<button class="pn-band pn-band--${b.id} ${state.filterBand === b.id ? "on" : ""}" aria-pressed=${state.filterBand === b.id ? "true" : "false"} @click=${() => { state.filterBand = state.filterBand === b.id ? "" : b.id; rerender(app); }}>
          <b>${g.stats.bands?.[b.id] ?? 0}</b><span>${b.label}</span>
        </button>`,
      )}</div>
      ${(() => {
        const cooling = g.nodes.filter((n) => n.warmTrend === "cooling").slice(0, 4);
        return cooling.length
          ? html`<div class="pn-chips">${cooling.map((n) => html`<button class="pn-chip" @click=${() => selectNode(app, client, n.id)}>▼ ${n.name} <b>${n.warmScore}</b></button>`)}</div>`
          : nothing;
      })()}
    </section>
    <section class="pn-sec">
      <h3>Most valuable relationships</h3>
      ${top.length
        ? html`<ul class="pn-list">${top.map(
            (n) => html`<li class="pn-li pn-click" @click=${() => selectNode(app, client, n.id)}>
              <span class="pn-dot" style="--tone:${typeColor(n.contactType)}"></span>
              <span class="pn-grow">${n.name}</span>
              ${warmPill(n)}
              <span class="pn-gold">${fmtMoney(n.relationshipValue + n.pipelineValue)}</span>
            </li>`,
          )}</ul>`
        : html`<p class="pn-muted">Add people and record what each connection gives you.</p>`}
    </section>
    <section class="pn-sec">
      <h3>Open opportunities (${open.length})</h3>
      ${open.length
        ? html`<ul class="pn-opps">${open.slice(0, 8).map((o) => html`<li class="pn-opp">
            <div class="pn-opp__main"><span class="pn-opp__name">${o.name}</span><span class="pn-stagechip" style="--tone:${stageTone(o.stage)}">${o.stage}</span></div>
            <div class="pn-opp__meta"><span>${fmtMoney(o.estimatedValue)}</span><span>via ${o.via === "connection" ? "a connection" : nodeName(o.viaId)}</span></div>
          </li>`)}</ul>`
        : html`<p class="pn-muted">No open opportunities are linked to your network yet.</p>`}
    </section>
    ${g.suggestedClients.length
      ? html`<section class="pn-sec">
          <h3>Clients with open deals, not in your network</h3>
          <div class="pn-chips">${g.suggestedClients.slice(0, 8).map(
            (c) => html`<button class="pn-chip" @click=${() => promoteClient(app, client, c.id)}>${icon("plus", 10)} ${c.name} <b>${c.openOpportunities}</b></button>`,
          )}</div>
        </section>`
      : nothing}
  `;
}

function renderContactPanel(app: AppViewState, client: GatewayBrowserClient, node: NetworkNode): TemplateResult {
  const d = state.detail && state.detailFor === node.id ? state.detail : null;
  const contact = d?.contact;
  const opps = d?.opportunities ?? [];
  const open = opps.filter((o) => o.open);
  const closed = opps.filter((o) => !o.open);
  const conns = d?.connections ?? [];
  const history = [
    ...(d?.history ?? []).map((h) => ({ at: h.at, text: historyText(h.objectType, h.field, h.from, h.to, h.objectId), actor: h.actor })),
    ...(d?.opportunityHistory ?? []).map((h) => ({
      at: h.at,
      text: `${opps.find((o) => o.id === h.opportunityId)?.name ?? "Deal"}: ${h.from} → ${h.to}`,
      actor: "pipeline",
    })),
  ].sort((a, b) => b.at - a.at);
  return html`
    <div class="pn-panel__head">
      <div class="pn-avatar" style="--tone:${typeColor(node.contactType)}">${node.name.slice(0, 2).toUpperCase()}</div>
      <div class="pn-grow">
        <div class="pn-panel__eyebrow">${typeChip(node.contactType)} ${node.isClient ? html`<span class="pn-client">CRM client${node.client?.pipelineStatus ? ` · ${node.client.pipelineStatus}` : ""}</span>` : nothing}</div>
        <h2 class="pn-panel__title">${node.name}</h2>
        <div class="pn-muted">${[node.role, node.org].filter(Boolean).join(" · ") || "—"}</div>
      </div>
      <button class="pn-x" title="Close" aria-label="Close panel" @click=${() => selectNode(app, client, null)}>${icon("x", 12)}</button>
    </div>

    <div class="pn-kpis">
      <div><span>Relationship value</span><b>${fmtMoney(node.relationshipValue)}</b></div>
      <div><span>Open pipeline</span><b>${fmtMoney(node.pipelineValue)}</b></div>
      <div><span>Open opps</span><b>${node.openOpportunities}</b></div>
    </div>

    ${renderWarmSection(app, client, node)}

    <div class="pn-row">
      <label class="pn-inline">
        <span>Status</span>
        <select class="wgk-input" aria-label="Contact status" .value=${node.status} @change=${(e: Event) => setContactStatus(app, client, node.id, (e.target as HTMLSelectElement).value)}>
          ${CONTACT_STATUSES.map((s) => html`<option value=${s} ?selected=${s === node.status}>${s}</option>`)}
        </select>
      </label>
      <div class="pn-inline"><span>Last touch</span>${staleLabel(node)}<button class="wgk-btn wgk-btn--sm" @click=${() => touchContact(app, client, node.id)}>Touched today</button></div>
    </div>

    ${node.nextAction
      ? html`<div class="pn-nextbox">${icon("arrowUp", 11)}<div><b>Next action</b><span>${node.nextAction}${node.nextActionDate ? ` — by ${node.nextActionDate}` : ""}</span></div></div>`
      : html`<div class="pn-nextbox pn-nextbox--empty">${icon("alert", 11)}<div><b>No next action</b><span>Edit the contact to set one.</span></div></div>`}

    <section class="pn-sec">
      <h3>Warm path from you</h3>
      ${!d
        ? html`<div class="wg-skel" style="height:22px"></div>`
        : d.path?.found
          ? html`<div class="pn-path">${d.path.nodeIds.map((id, i) => html`${i ? html`<span class="pn-path__arrow">→</span>` : nothing}<button class="pn-path__step" @click=${() => id !== node.id && selectNode(app, client, id)}>${nodeName(id)}</button>`)}</div>
              <div class="pn-muted">weakest tie ${d.path.minStrength}/5 · ${d.path.nodeIds.length - 1} hop${d.path.nodeIds.length === 2 ? "" : "s"}</div>`
          : html`<p class="pn-muted">No path yet — connect them to you or to someone you know.</p>`}
    </section>

    <section class="pn-sec">
      <h3>Value from each connection</h3>
      ${!d
        ? html`<div class="wg-skel" style="height:40px"></div>`
        : conns.length
          ? html`<ul class="pn-values">${conns.map(
              (c) => html`<li>
                <button class="pn-values__who" @click=${() => openEditConnection(app, c.connectionId, client)} title="Edit connection">
                  <b>${c.otherName}</b><span>${c.relationshipType}</span>${strengthStars(c.strength)}${c.status !== "Active" ? html`<span class="pn-late">${c.status}</span>` : nothing}
                </button>
                ${c.values.length
                  ? html`<ul>${c.values.map((v) => html`<li><span class="pn-vt">${v.valueType}</span>${v.estimatedValue ? html`<b class="pn-gold">${fmtMoney(v.estimatedValue)}</b>` : nothing}<span>${v.description}</span></li>`)}</ul>`
                  : html`<p class="pn-muted">No value recorded — what does this connection give you?</p>`}
              </li>`,
            )}</ul>`
          : html`<p class="pn-muted">Not connected to anyone yet.</p>`}
    </section>

    <section class="pn-sec">
      <div class="pn-sec__head"><h3>Open opportunities (${open.length})</h3><button class="wgk-btn wgk-btn--sm" @click=${() => openLinkOpportunity(app, client, node.id)}>${icon("link", 11)}<span>Link</span></button></div>
      ${!d ? html`<div class="wg-skel" style="height:40px"></div>` : open.length ? html`<ul class="pn-opps">${open.map((o) => renderOppRow(app, client, o))}</ul>` : html`<p class="pn-muted">No open opportunities.</p>`}
      ${closed.length ? html`<details class="pn-closed"><summary>${closed.length} closed</summary><ul class="pn-opps">${closed.map((o) => renderOppRow(app, client, o))}</ul></details>` : nothing}
    </section>

    ${renderLinkedSection(app, client, "contact", node.id, node.name)}

    ${contact && (Object.keys(contact.channels).length || contact.client?.email || contact.client?.phone)
      ? html`<section class="pn-sec"><h3>Channels</h3><div class="pn-chips">${[
          ...Object.entries(contact.channels),
          ...(contact.client?.email && !contact.channels.email ? [["email (client)", contact.client.email]] : []),
          ...(contact.client?.phone && !contact.channels.phone ? [["phone (client)", contact.client.phone]] : []),
        ].map(([k, v]) => html`<span class="pn-chip pn-chip--static"><b>${k}</b> ${v}</span>`)}</div></section>`
      : nothing}
    ${node.tags.length ? html`<section class="pn-sec"><h3>Tags</h3><div class="pn-chips">${node.tags.map((t) => html`<button class="pn-chip" @click=${() => { state.filterTag = t; rerender(app); }}>#${t}</button>`)}</div></section>` : nothing}
    ${contact?.notes ? html`<section class="pn-sec"><h3>Notes</h3><p class="pn-notes">${contact.notes}</p></section>` : nothing}

    <section class="pn-sec">
      <h3>Status history</h3>
      ${history.length
        ? html`<ol class="pn-hist">${history.slice(0, 14).map((h) => html`<li><time>${new Date(h.at).toLocaleDateString()}</time><span>${h.text}</span><em>${h.actor}</em></li>`)}</ol>`
        : html`<p class="pn-muted">${d ? "No changes yet." : "Loading…"}</p>`}
    </section>

    <div class="pn-panel__actions">
      ${contact ? html`<button class="wgk-btn" @click=${() => openEditContact(app, contact)}>Edit</button>` : nothing}
      <button class="wgk-btn" @click=${() => openConnect(app, node.id)}>${icon("link", 12)}<span>Connect to…</span></button>
      <button class="wgk-btn wgk-btn--danger" @click=${() => deleteContact(app, client, node.id)}>${icon("trash", 12)}<span>Remove</span></button>
    </div>
  `;
}

function historyText(objectType: string, field: string, from: string, to: string, objectId: string): string {
  const what = objectType === "connection" ? "Connection" : "Contact";
  if (field === "created") return `${what} added${to ? ` (${to})` : ""}`;
  if (field === "deleted") return `${what} removed`;
  if (field === "opportunity.linked") return `Linked to ${to}`;
  if (field === "opportunity.unlinked") return `Opportunity unlinked`;
  if (field === "values") return `${what} value updated`;
  if (field === "link.added") return `Linked ${to}`;
  if (field === "link.removed") return `Unlinked ${from}`;
  if (field === "lastTouchDate") return `${what} touched ${to || "—"}`;
  if (field === "warmOverride") return to ? `Warm score pinned at ${to}` : `Warm score back to the formula`;
  void objectId;
  return `${what} ${field}: ${from || "—"} → ${to || "—"}`;
}

// ═══════════════════════════════════════════════════════════════════
// TABLE
// ═══════════════════════════════════════════════════════════════════

function meEdge(id: string): NetworkEdge | undefined {
  return state.graph?.edges.find((e) => (e.from === ME_ID && e.to === id) || (e.to === ME_ID && e.from === id));
}

function renderTable(app: AppViewState, client: GatewayBrowserClient, nodes: NetworkNode[]): TemplateResult {
  const rows = [...nodes].sort((a, b) =>
    state.sortBy === "warm" ? b.warmScore - a.warmScore : b.relationshipValue + b.pipelineValue - (a.relationshipValue + a.pipelineValue),
  );
  const sortBtn = (key: "value" | "warm", label: string, num = true) =>
    html`<th class=${num ? "num" : ""} aria-sort=${state.sortBy === key ? "descending" : "none"}><button class="pn-sortbtn ${state.sortBy === key ? "on" : ""}" @click=${() => { state.sortBy = key; rerender(app); }}>${label}${state.sortBy === key ? " ▾" : ""}</button></th>`;
  return html`<div class="pn-tablewrap">
    <table class="pn-table">
      <thead><tr><th>Person</th><th>Type</th><th>Status</th>${sortBtn("warm", "Warm")}${sortBtn("value", "Value")}<th class="num">Open opps</th><th>Tie to you</th><th>Last touch</th><th>Next action</th></tr></thead>
      <tbody>
        ${rows.map((n) => {
          const e = meEdge(n.id);
          return html`<tr class=${n.id === state.selectedId ? "is-sel" : ""} tabindex="0" @click=${() => selectNode(app, client, n.id)} @keydown=${(ev: KeyboardEvent) => { if (ev.key === "Enter") selectNode(app, client, n.id); }}>
            <td data-label="Person"><div class="pn-person"><span class="pn-dot" style="--tone:${typeColor(n.contactType)}"></span><div><b>${n.name}</b>${n.isClient ? html` <span class="pn-client">client</span>` : nothing}<small>${[n.role, n.org].filter(Boolean).join(" · ")}</small></div></div></td>
            <td data-label="Type">${typeChip(n.contactType)}</td>
            <td data-label="Status">${n.status}</td>
            <td data-label="Warm" class="num">${warmPill(n)} ${trendChip(n)}</td>
            <td data-label="Value" class="num"><b class="pn-gold">${fmtMoney(n.relationshipValue + n.pipelineValue)}</b></td>
            <td data-label="Open opps" class="num">${n.openOpportunities ? html`<span class="pn-badge">${n.openOpportunities}</span>` : "0"}</td>
            <td data-label="Tie to you">${e ? html`<span class="pn-tie">${e.relationshipType} ${strengthStars(e.strength)}</span>` : html`<span class="pn-muted">indirect</span>`}</td>
            <td data-label="Last touch">${staleLabel(n)}</td>
            <td data-label="Next action">${n.nextAction || html`<span class="pn-muted">—</span>`}</td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════════

function renderContactModal(app: AppViewState, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  const m = state.modal;
  if (!m || m.kind !== "contact") return nothing;
  const d = m.draft;
  const set = <K extends keyof ContactDraft>(k: K, v: ContactDraft[K]) => {
    d[k] = v;
    rerender(app);
  };
  const isEdit = Boolean(m.editingId);
  return wgkModal({
    eyebrow: "My Network · Person",
    title: isEdit ? "Edit contact" : "Add someone to your network",
    onClose: () => closeModal(app),
    width: 760,
    error: state.modalError,
    body: html`
      ${wgkSection("Who")}
      ${wgkField("Name *", d.name, (v) => set("name", v), { placeholder: "Full name" })}
      ${wgkSelect("Type", d.contactType, CONTACT_TYPES, (v) => set("contactType", v))}
      ${wgkField("Organization", d.org, (v) => set("org", v))}
      ${wgkField("Role", d.role, (v) => set("role", v), { placeholder: "e.g. Partner, CTO" })}
      ${wgkSelect("Status", d.status, CONTACT_STATUSES, (v) => set("status", v))}
      ${wgkField("Tags", d.tags, (v) => set("tags", v), { placeholder: "comma separated" })}
      ${wgkSection("Channels")}
      ${wgkField("Email", d.email, (v) => set("email", v), { type: "email" })}
      ${wgkField("Phone", d.phone, (v) => set("phone", v))}
      ${wgkField("LinkedIn", d.linkedin, (v) => set("linkedin", v))}
      ${wgkField("Website", d.website, (v) => set("website", v))}
      ${wgkSection("Follow-up")}
      ${wgkField("Next action", d.nextAction, (v) => set("nextAction", v), { placeholder: "e.g. Ask for intro to their CFO" })}
      ${wgkField("Next action date", d.nextActionDate, (v) => set("nextActionDate", v), { type: "date" })}
      ${wgkField("Last touch", d.lastTouchDate, (v) => set("lastTouchDate", v), { type: "date" })}
      ${wgkField("Notes", d.notes, (v) => set("notes", v), { area: true, span: true })}
      ${!isEdit
        ? html`${wgkSection("Your connection to them")}
            <label class="wgk-field wgk-span pn-check"><input type="checkbox" .checked=${d.connectToMe} @change=${(e: Event) => set("connectToMe", (e.target as HTMLInputElement).checked)} /><span>I know this person directly</span></label>
            ${d.connectToMe
              ? html`${wgkSelect("Relationship", d.meRelationship, RELATIONSHIP_TYPES, (v) => set("meRelationship", v))}
                  ${strengthField(d.meStrength, (n) => set("meStrength", n))}
                  ${wgkSelect("What they give you", d.meValueType, VALUE_TYPES, (v) => set("meValueType", v))}
                  ${wgkField("Estimated $ value", d.meValueAmount || "", (v) => set("meValueAmount", Number(v) || 0), { type: "number", placeholder: "optional" })}
                  ${wgkField("Value description", d.meValueDescription, (v) => set("meValueDescription", v), { span: true, placeholder: "e.g. Warm intros to Series A investors" })}`
              : nothing}`
        : nothing}
    `,
    foot: html`<div class="wgk-modal__foot-end">
      <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
      <button class="wgk-btn wgk-btn--primary" ?disabled=${state.saving} @click=${() => saveContact(app, client)}>${state.saving ? "Saving…" : isEdit ? "Save" : "Add to network"}</button>
    </div>`,
  });
}

function strengthField(value: number, onChange: (n: number) => void): TemplateResult {
  return html`<div class="wgk-field">
    <span class="wgk-label">Strength (1 weak – 5 strong)</span>
    <div class="pn-strength" role="radiogroup" aria-label="Strength">
      ${[1, 2, 3, 4, 5].map((n) => html`<button type="button" role="radio" aria-checked=${n === value ? "true" : "false"} class=${n <= value ? "on" : ""} @click=${() => onChange(n)}>${n}</button>`)}
    </div>
  </div>`;
}

function personOptions(): Array<{ id: string; label: string }> {
  return [{ id: ME_ID, label: `${state.graph?.me.label ?? "You"} (me)` }, ...(state.graph?.nodes ?? []).map((n) => ({ id: n.id, label: n.name }))];
}

function renderConnectModal(app: AppViewState, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  const m = state.modal;
  if (!m || m.kind !== "connect") return nothing;
  const d = m.draft;
  const set = <K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) => {
    d[k] = v;
    rerender(app);
  };
  const people = personOptions();
  const isEdit = Boolean(m.editingId);
  const sel = (label: string, value: string, onChange: (v: string) => void) => html`<label class="wgk-field">
    <span class="wgk-label">${label}</span>
    <select class="wgk-input" ?disabled=${isEdit} .value=${value} @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
      <option value="" ?selected=${!value}>Pick a person…</option>
      ${people.map((p) => html`<option value=${p.id} ?selected=${p.id === value}>${p.label}</option>`)}
    </select>
  </label>`;
  return wgkModal({
    eyebrow: "My Network · Connection",
    title: isEdit ? `${nodeName(d.fromId)} ↔ ${nodeName(d.toId)}` : "Connect two people",
    onClose: () => closeModal(app),
    width: 760,
    error: state.modalError,
    body: html`
      ${sel("Person A", d.fromId, (v) => set("fromId", v))}
      ${sel("Person B", d.toId, (v) => set("toId", v))}
      ${wgkSelect("Relationship", d.relationshipType, RELATIONSHIP_TYPES, (v) => set("relationshipType", v))}
      ${strengthField(d.strength, (n) => set("strength", n))}
      ${wgkSelect("Direction", d.direction, CONNECTION_DIRECTIONS, (v) => set("direction", v), {
        labels: { mutual: "Mutual", forward: "A → B (A introduced / gives to B)", backward: "B → A" },
      })}
      ${wgkSelect("Status", d.status, CONNECTION_STATUSES, (v) => set("status", v))}
      ${wgkField("Last touch", d.lastTouchDate, (v) => set("lastTouchDate", v), { type: "date" })}
      ${wgkField("Notes", d.notes, (v) => set("notes", v), { placeholder: isEdit ? "leave empty to keep" : "" })}
      ${wgkSection("Value — what this connection gives you")}
      <div class="wgk-span pn-valrows">
        ${d.values.map(
          (v, i) => html`<div class="pn-valrow">
            <select class="wgk-input" aria-label="Value type" .value=${v.valueType} @change=${(e: Event) => { v.valueType = (e.target as HTMLSelectElement).value; rerender(app); }}>
              ${VALUE_TYPES.map((t) => html`<option value=${t} ?selected=${t === v.valueType}>${t}</option>`)}
            </select>
            <input class="wgk-input" type="number" aria-label="Estimated dollar value" placeholder="$ (optional)" .value=${v.estimatedValue ? String(v.estimatedValue) : ""} @input=${(e: Event) => { v.estimatedValue = Number((e.target as HTMLInputElement).value) || undefined; }} />
            <input class="wgk-input" aria-label="Value description" placeholder="What exactly? e.g. intro to 3 VCs" .value=${v.description} @input=${(e: Event) => { v.description = (e.target as HTMLInputElement).value; }} />
            <button class="pn-x" type="button" aria-label="Remove value" @click=${() => { d.values.splice(i, 1); rerender(app); }}>${icon("x", 10)}</button>
          </div>`,
        )}
        <button class="wgk-btn wgk-btn--sm" type="button" @click=${() => { d.values.push({ valueType: "other", description: "" }); rerender(app); }}>${icon("plus", 11)}<span>Add value</span></button>
      </div>
      ${isEdit ? html`<div class="wgk-span wg-pn-embed">${renderLinkedSection(app, client, "connection", m.editingId!, `${nodeName(d.fromId)} ↔ ${nodeName(d.toId)}`)}</div>` : nothing}
    `,
    foot: html`
      ${isEdit ? html`<button class="wgk-btn wgk-btn--danger" @click=${() => deleteConnection(app, client, m.editingId!)}>${icon("trash", 12)}<span>Remove</span></button>` : nothing}
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
        <button class="wgk-btn wgk-btn--primary" ?disabled=${state.saving} @click=${() => saveConnection(app, client)}>${state.saving ? "Saving…" : isEdit ? "Save" : "Connect"}</button>
      </div>`,
  });
}

function renderLinkModal(app: AppViewState, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  const m = state.modal;
  if (!m || m.kind !== "link") return nothing;
  const conns = (state.graph?.edges ?? []).filter((e) => e.from === m.contactId || e.to === m.contactId);
  return wgkModal({
    eyebrow: "My Network · Opportunity",
    title: `Link an opportunity to ${nodeName(m.contactId)}`,
    onClose: () => closeModal(app),
    width: 560,
    stack: true,
    error: state.modalError,
    body: m.loading
      ? html`<div class="wg-skel" style="height:40px"></div>`
      : m.options.length
        ? html`
            <label class="wgk-field"><span class="wgk-label">Opportunity</span>
              <select class="wgk-input" .value=${m.opportunityId} @change=${(e: Event) => { m.opportunityId = (e.target as HTMLSelectElement).value; rerender(app); }}>
                ${m.options.map((o) => html`<option value=${o.id} ?selected=${o.id === m.opportunityId}>${o.name} — ${o.stage} · ${fmtMoney(o.estimatedValue)}</option>`)}
              </select>
            </label>
            <label class="wgk-field"><span class="wgk-label">Attach to</span>
              <select class="wgk-input" .value=${m.target} @change=${(e: Event) => { m.target = (e.target as HTMLSelectElement).value; rerender(app); }}>
                <option value=${`contact:${m.contactId}`}>${nodeName(m.contactId)} (the person)</option>
                ${conns.map((e) => html`<option value=${`connection:${e.id}`}>The connection ${nodeName(e.from)} ↔ ${nodeName(e.to)} (warm intro)</option>`)}
              </select>
            </label>
            ${wgkField("Role in the deal", m.role, (v) => { m.role = v; }, { placeholder: "e.g. decision-maker, introducer, champion" })}`
        : html`<p class="pn-muted">No opportunities yet — create one on the Register › Opportunities page first.</p>`,
    foot: html`<div class="wgk-modal__foot-end">
      <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
      <button class="wgk-btn wgk-btn--primary" ?disabled=${state.saving || !m.opportunityId} @click=${() => saveLink(app, client)}>${state.saving ? "Linking…" : "Link"}</button>
    </div>`,
  });
}

function renderLinkObjectModal(app: AppViewState, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  const m = state.modal;
  if (!m || m.kind !== "linkObject") return nothing;
  const byType = new Map<string, typeof m.results>();
  for (const r of m.results) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
  return wgkModal({
    eyebrow: `My Network · Link ${m.target}`,
    title: `Link to ${m.title}`,
    onClose: () => closeLinkPicker(app),
    width: 640,
    stack: true,
    error: state.modalError,
    body: html`
      <label class="pn-search wgk-span">${icon("search", 13)}<input type="search" aria-label="Search projects, notes, tasks, files…" placeholder="Search projects, notes, tasks, files, ideas, events…" .value=${m.query} @input=${(e: Event) => setLinkPickerQuery(app, client, (e.target as HTMLInputElement).value)} /></label>
      <div class="pn-typetabs wgk-span" role="tablist" aria-label="Object type">
        <button role="tab" aria-selected=${m.type === "" ? "true" : "false"} class=${m.type === "" ? "on" : ""} @click=${() => setLinkPickerQuery(app, client, m.query, "")}>All</button>
        ${LINKABLE_TYPES.map((t) => html`<button role="tab" aria-selected=${m.type === t ? "true" : "false"} class=${m.type === t ? "on" : ""} @click=${() => setLinkPickerQuery(app, client, m.query, t)}>${OBJECT_TYPE_PLURAL[t] ?? t}</button>`)}
      </div>
      ${wgkField("Role (optional)", m.role, (v) => { m.role = v; }, { placeholder: "e.g. stakeholder, author, advisor", span: true })}
      <div class="wgk-span pn-pickres">
        ${m.loading && !m.results.length
          ? html`<div class="wg-skel" style="height:80px"></div>`
          : m.results.length
            ? [...byType.entries()].map(
                ([t, list]) => html`<div class="pn-lgroup">
                  <div class="pn-lgroup__h">${OBJECT_TYPE_PLURAL[t] ?? t}<b>${list.length}</b></div>
                  <ul>${list.map(
                    (r) => html`<li class="pn-litem">
                      <span class="pn-lglyph" data-type=${r.type}>${(OBJECT_TYPE_LABEL[r.type] ?? r.type).charAt(0)}</span>
                      <div class="pn-litem__open"><b>${r.label}</b><small>${r.subtitle}</small></div>
                      <button class="wgk-btn wgk-btn--sm wgk-btn--primary" ?disabled=${state.saving} @click=${() => saveObjectLink(app, client, r)}>${icon("link", 11)}<span>Link</span></button>
                    </li>`,
                  )}</ul>
                </div>`,
              )
            : html`<p class="pn-muted">Nothing matches${m.query ? ` “${m.query}”` : ""}.</p>`}
      </div>
    `,
    foot: html`<div class="wgk-modal__foot-end"><button class="wgk-btn" @click=${() => closeLinkPicker(app)}>Done</button></div>`,
  });
}

function renderClientsModal(app: AppViewState, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  const m = state.modal;
  if (!m || m.kind !== "clients") return nothing;
  return wgkModal({
    eyebrow: "My Network · From your CRM",
    title: "Add clients to your network",
    onClose: () => closeModal(app),
    width: 620,
    stack: true,
    error: state.modalError,
    body: html`
      <p class="pn-muted">Clients stay in your CRM — the network links to the client record, it doesn't copy it.</p>
      <label class="pn-search">${icon("search", 13)}<input type="search" aria-label="Search clients" placeholder="Search clients by name, email or phone…" .value=${m.query} @input=${(e: Event) => searchClients(app, client, (e.target as HTMLInputElement).value)} /></label>
      ${m.loading && !m.results.length
        ? html`<div class="wg-skel" style="height:80px"></div>`
        : m.results.length
          ? html`<ul class="pn-list pn-clients">${m.results.map(
              (c) => html`<li class="pn-li">
                <span class="pn-dot" style="--tone:${typeColor("client")}"></span>
                <div class="pn-grow"><b>${c.name}</b><small>${[c.pipelineStatus, c.email, c.phone].filter(Boolean).join(" · ")}</small></div>
                ${c.inNetwork
                  ? html`<button class="wgk-btn wgk-btn--sm" @click=${() => { closeModal(app); selectNode(app, client, c.inNetwork!); }}>In network</button>`
                  : html`<button class="wgk-btn wgk-btn--sm wgk-btn--primary" @click=${() => promoteClient(app, client, c.id)}>${icon("plus", 11)}<span>Add</span></button>`}
              </li>`,
            )}</ul>`
          : html`<p class="pn-muted">No clients match.</p>`}
    `,
    foot: html`<div class="wgk-modal__foot-end"><button class="wgk-btn" @click=${() => closeModal(app)}>Done</button></div>`,
  });
}

// ═══════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════

function renderLegend(): TemplateResult {
  return html`<div class="pn-legend" aria-label="Legend">
    ${CONTACT_TYPES.map((t) => html`<span><i style="--tone:${typeColor(t)}"></i>${t}</span>`)}
    <span><i class="ring"></i>client</span>
    <span><i class="badge">2</i>open opps</span>
    <span><i class="arc"></i>warm score</span>
    <span class="pn-muted">${state.layout === "rings" ? "closer = warmer · " : ""}size = value · line = strength</span>
  </div>`;
}

/** Last `?contact=` deep link acted on (People chips on object pages link here). */
let handledContactParam = "";

function applyContactParam(app: AppViewState, client: GatewayBrowserClient) {
  if (typeof window === "undefined" || !state.graph) return;
  const id = new URLSearchParams(window.location.search).get("contact") ?? "";
  if (!id || id === handledContactParam) return;
  handledContactParam = id;
  if (state.graph.nodes.some((n) => n.id === id) && state.selectedId !== id) {
    // Make sure filters don't hide the person we were sent to.
    clearFilters(app);
    queueMicrotask(() => selectNode(app, client, id));
  }
}

export function renderPeopleNetwork(app: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (!state.loaded && !state.loading) void loadNetwork(app, client);
  applyContactParam(app, client);
  const g = state.graph;
  const nodes = filteredNodes();
  const visible = new Set(nodes.map((n) => n.id));
  visible.add(ME_ID);
  const edges = (g?.edges ?? []).filter((e) => visible.has(e.from) && visible.has(e.to));
  const selectedNode = state.selectedId && state.selectedId !== ME_ID ? g?.nodes.find((n) => n.id === state.selectedId) : null;
  const path = state.detail && state.detailFor === state.selectedId ? state.detail.path : null;
  const tags = knownTags();
  const linkedOpts = linkedObjectOptions();
  const sats = state.showSatellites && state.view === "graph" ? satellitesFor(visible) : [];
  const panelOpen = Boolean(g && (state.selectedId || g.nodes.length));

  return html`
    <div class="wg-page wg-kis wg-pn">
      ${wgAurora()}
      ${wgHero({
        eyebrow: "Business · Relationships",
        title: html`My <span class="wg-gold">Network</span>`,
        sub: html`<span class="pn-sub-long">Everyone you know — clients included — how they connect, how warm each relationship is, what it's worth, and the opportunities riding on them.</span><span class="pn-sub-short">Who you know, how warm, and what it's worth.</span>`,
        actions: html`
          <button class="wgk-btn" @click=${() => openClientPicker(app, client)}>${icon("users", 13)}<span>Add from clients</span></button>
          ${(g?.nodes.length ?? 0) < 2
            ? html`<span class="pn-disabled-wrap" tabindex="0" title="Add at least 2 people to connect them to each other" aria-describedby="pn-connect-why">
                <button class="wgk-btn pn-btn-disabled" disabled aria-disabled="true">${icon("link", 13)}<span>Connect people</span></button>
                <span id="pn-connect-why" class="pn-tip" role="tooltip">Add at least 2 people to connect them</span>
              </span>`
            : html`<button class="wgk-btn" @click=${() => openConnect(app)}>${icon("link", 13)}<span>Connect people</span></button>`}
          <button class="wgk-btn wgk-btn--primary" @click=${() => openAddContact(app)}>${icon("plus", 13)}<span>Add person</span></button>
        `,
      })}

      ${g
        ? html`<div class="wg-stats pn-stats">
            ${wgStat("People", g.stats.contacts, `${g.stats.clients} clients`)}
            ${wgStat("Avg warm score", g.stats.avgWarm ?? 0, `${g.stats.bands?.inner ?? 0} in your inner circle`)}
            ${wgStat("Connections", g.stats.connections)}
            ${wgStat("Relationship value", fmtMoney(g.stats.relationshipValue), "recorded on connections")}
            ${wgStat("Open opportunities", g.stats.openOpportunities, fmtMoney(g.stats.pipelineValue))}
            ${wgStat("Stale", g.stats.stale, "> 30 days or never")}
          </div>`
        : nothing}

      <div class="pn-filters" role="search">
        <label class="pn-search">${icon("search", 13)}<input type="search" aria-label="Search people" placeholder="Search name, org, role, tag…" .value=${state.query} @input=${(e: Event) => { state.query = (e.target as HTMLInputElement).value; rerender(app); }} /></label>
        <select class="wgk-input" aria-label="Filter by type" .value=${state.filterType} @change=${(e: Event) => { state.filterType = (e.target as HTMLSelectElement).value; rerender(app); }}>
          <option value="">All types</option>
          ${CONTACT_TYPES.map((t) => html`<option value=${t} ?selected=${t === state.filterType}>${t}</option>`)}
        </select>
        <select class="wgk-input" aria-label="Filter by tag" .value=${state.filterTag} @change=${(e: Event) => { state.filterTag = (e.target as HTMLSelectElement).value; rerender(app); }}>
          <option value="">All tags</option>
          ${tags.map((t) => html`<option value=${t} ?selected=${t === state.filterTag}>#${t}</option>`)}
        </select>
        <select class="wgk-input" aria-label="Filter by staleness" .value=${String(state.filterStaleDays)} @change=${(e: Event) => { state.filterStaleDays = Number((e.target as HTMLSelectElement).value) || 0; rerender(app); }}>
          ${STALE_OPTIONS.map(([v, l]) => html`<option value=${String(v)} ?selected=${v === state.filterStaleDays}>${l}</option>`)}
        </select>
        <select class="wgk-input" aria-label="Filter by warmth ring" .value=${state.filterBand} @change=${(e: Event) => { state.filterBand = (e.target as HTMLSelectElement).value; rerender(app); }}>
          <option value="">Any warmth</option>
          ${WARM_BANDS.map((b) => html`<option value=${b.id} ?selected=${b.id === state.filterBand}>${b.label}</option>`)}
        </select>
        ${linkedOpts.length
          ? html`<select class="wgk-input pn-linkedsel" aria-label="Filter by linked item" .value=${state.filterLinked} @change=${(e: Event) => { state.filterLinked = (e.target as HTMLSelectElement).value; rerender(app); }}>
              <option value="">Linked to anything</option>
              ${linkedOpts.map((o) => html`<option value=${o.key} ?selected=${o.key === state.filterLinked}>${OBJECT_TYPE_LABEL[o.type] ?? o.type}: ${o.label} (${o.people})</option>`)}
            </select>`
          : nothing}
        <label class="pn-toggle"><input type="checkbox" .checked=${state.filterOpen} @change=${(e: Event) => { state.filterOpen = (e.target as HTMLInputElement).checked; rerender(app); }} /><span>Has open opps</span></label>
        ${filtersActive() ? html`<button class="wgk-btn wgk-btn--sm" @click=${() => clearFilters(app)}>Clear</button>` : nothing}
        ${state.view === "graph"
          ? html`<div class="pn-seg pn-seg--layout" role="tablist" aria-label="Graph layout">
                <button role="tab" aria-selected=${state.layout === "rings" ? "true" : "false"} class=${state.layout === "rings" ? "on" : ""} @click=${() => { state.layout = "rings"; rerender(app); }}>Rings</button>
                <button role="tab" aria-selected=${state.layout === "free" ? "true" : "false"} class=${state.layout === "free" ? "on" : ""} @click=${() => { state.layout = "free"; rerender(app); }}>Free</button>
              </div>
              ${state.links.length ? html`<label class="pn-toggle"><input type="checkbox" .checked=${state.showSatellites} @change=${(e: Event) => { state.showSatellites = (e.target as HTMLInputElement).checked; rerender(app); }} /><span>Show linked items</span></label>` : nothing}`
          : nothing}
        <div class="pn-seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected=${state.view === "graph" ? "true" : "false"} class=${state.view === "graph" ? "on" : ""} @click=${() => { state.view = "graph"; rerender(app); }}>Graph</button>
          <button role="tab" aria-selected=${state.view === "list" ? "true" : "false"} class=${state.view === "list" ? "on" : ""} @click=${() => { state.view = "list"; rerender(app); }}>List</button>
        </div>
      </div>

      ${state.error ? html`<div class="wgk-err" role="alert">${state.error}</div>` : nothing}

      ${!g
        ? html`<div class="pn-body"><div class="wg-surface pn-stage-skel"><div class="wg-skel" style="height:100%"></div></div></div>`
        : !g.nodes.length
          ? html`<div class="wg-surface pn-empty">${wgEmpty({
              icon: icon("users", 24),
              title: "Start your network",
              body: "Add the people you know — or bring in your CRM clients — then connect them and note what each relationship gives you. Opportunities you link show up on the people involved.",
              action: html`<div class="pn-empty__actions"><button class="wgk-btn wgk-btn--primary" @click=${() => openAddContact(app)}>${icon("plus", 13)}<span>Add a person</span></button><button class="wgk-btn" @click=${() => openClientPicker(app, client)}>${icon("users", 13)}<span>Add from clients</span></button></div>`,
            })}</div>`
          : html`<div class="pn-body ${panelOpen ? "has-panel" : ""}">
              <div class="wg-surface pn-stage ${state.view === "list" ? "pn-stage--list" : ""}">
                ${state.view === "graph"
                  ? html`<people-network-graph
                        .nodes=${nodes}
                        .edges=${edges}
                        .meLabel=${g.me.label}
                        .selectedId=${state.selectedId}
                        .selectedEdgeId=${state.selectedEdgeId}
                        .pathNodeIds=${path?.found ? path.nodeIds : []}
                        .pathEdgeIds=${path?.found ? path.edgeIds : []}
                        .staleAfterDays=${state.filterStaleDays || 30}
                        .layout=${state.layout}
                        .satellites=${sats}
                        @satellite-select=${(e: CustomEvent<{ type: string; id: string }>) => {
                          const l = state.links.find((x) => x.type === e.detail.type && x.id === e.detail.id);
                          openLinked(app, e.detail.type, e.detail.id, l?.label ?? "");
                        }}
                        @node-select=${(e: CustomEvent<{ id: string }>) => selectNode(app, client, e.detail.id)}
                        @edge-select=${(e: CustomEvent<{ id: string }>) => { state.selectedEdgeId = e.detail.id; openEditConnection(app, e.detail.id, client); }}
                        @background-click=${() => { if (state.selectedId) selectNode(app, client, null); }}
                      ></people-network-graph>
                      ${renderLegend()}
                      ${nodes.length === 0 ? html`<div class="pn-nomatch">No one matches these filters. <button class="wgk-btn wgk-btn--sm" @click=${() => clearFilters(app)}>Clear filters</button></div>` : nothing}`
                  : nodes.length
                    ? renderTable(app, client, nodes)
                    : html`<div class="pn-nomatch">No one matches these filters. <button class="wgk-btn wgk-btn--sm" @click=${() => clearFilters(app)}>Clear filters</button></div>`}
              </div>
              <aside class="wg-surface pn-panel" aria-label="Details">
                ${selectedNode ? renderContactPanel(app, client, selectedNode) : renderMePanel(app, client)}
              </aside>
            </div>`}

      ${state.toast ? html`<div class="pn-toast" role="status">${state.toast}</div>` : nothing}
      ${renderContactModal(app, client)}
      ${renderConnectModal(app, client)}
      ${renderLinkModal(app, client)}
      ${renderClientsModal(app, client)}
      ${renderLinkObjectModal(app, client)}
    </div>
  `;
}

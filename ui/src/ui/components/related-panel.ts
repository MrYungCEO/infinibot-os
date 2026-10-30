/**
 * Related panel — the visible face of the KIS typed-relation graph (`objrel.*`).
 *
 * Given any business object `(type, id)` it loads the connected neighborhood via
 * the `objrel.graph` RPC and renders the typed edges around it, so a user can see
 * (and mentally traverse) Client → Opportunities → Projects → Tasks → People plus
 * attached Decisions / Risks / Commitments — the whole point of Phase 1 (spec
 * §4/§14: create once, reference throughout).
 *
 * Self-contained (module-level cache, mirrors the object controllers) so it drops
 * into any view — the new object views' edit modals AND the existing Clients /
 * Projects surfaces — without touching app-view-state.
 *
 * Graceful degradation: `objrel.graph` is a Sprint-1 foundation RPC. If the
 * running gateway predates it (needs a restart to serve new methods) the request
 * rejects; the panel shows a soft "relations service not available" note instead
 * of crashing the host view.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

interface RelNode {
  type: string;
  id: string;
}
interface RelEdge {
  id: string;
  fromType: string;
  fromId: string;
  edge: string;
  toType: string;
  toId: string;
}
interface RelGraph {
  root: RelNode;
  nodes: RelNode[];
  edges: RelEdge[];
}

interface Entry {
  loading: boolean;
  loaded: boolean;
  graph: RelGraph | null;
  error: string | null;
}

const cache = new Map<string, Entry>();
const keyFor = (type: string, id: string) => `${type}:${id}`;

/** Drop the cached neighborhood so the next render re-fetches (call after linking). */
export function invalidateRelated(type: string, id: string): void {
  cache.delete(keyFor(type, id));
}

async function loadGraph(app: AppViewState, client: GatewayBrowserClient, type: string, id: string) {
  const entry = cache.get(keyFor(type, id));
  if (!entry) return;
  entry.loading = true;
  entry.error = null;
  try {
    const g = (await client.request("objrel.graph", { type, id, maxDepth: 3 })) as RelGraph;
    entry.graph = g && Array.isArray(g.edges) ? g : { root: { type, id }, nodes: [], edges: [] };
    entry.loaded = true;
  } catch (e) {
    entry.error = String(e);
  } finally {
    entry.loading = false;
    app.requestUpdate?.();
  }
}

const EDGE_LABEL: Record<string, string> = {
  client_has_opportunity: "opportunity",
  opportunity_becomes_project: "project",
  project_has_task: "task",
  project_delivers_product: "product",
  product_offered_in_opportunity: "offered in",
  decision_guides_task: "guides",
  risk_impacts_task: "impacts",
  commitment_funds_project: "funds",
  task_assigned_to_person: "assigned to",
  issue_relates_task: "relates to",
  relates_to: "relates to",
};

const TYPE_LABEL: Record<string, string> = {
  client: "Client",
  opportunity: "Opportunity",
  project: "Project",
  task: "Task",
  product: "Product",
  decision: "Decision",
  risk: "Risk",
  commitment: "Commitment",
  person: "Person",
  issue: "Issue",
};

const shortId = (id: string) => (id && id.length > 10 ? `${id.slice(0, 8)}…` : id || "?");
const typeName = (t: string) => TYPE_LABEL[t] || t;
const edgeName = (e: string) => EDGE_LABEL[e] || e.replace(/_/g, " ");

function nodeChip(node: RelNode, isRoot: boolean, compact = false): TemplateResult {
  return html`<span
    style="display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:${compact ? "1px 6px" : "2px 8px"}; border-radius:999px; white-space:nowrap;
      border:1px solid ${isRoot ? "rgba(251,191,36,0.5)" : "rgba(255,255,255,0.14)"};
      background:${isRoot ? "rgba(251,191,36,0.12)" : "rgba(255,255,255,0.04)"};
      color:${isRoot ? "#fbbf24" : "rgba(245,245,244,0.8)"};"
    title=${`${node.type}:${node.id}`}
  >
    <b style="font-weight:600;">${typeName(node.type)}</b>
    <span style="opacity:0.6; font-family:monospace; font-size:10px;">${shortId(node.id)}</span>
  </span>`;
}

/** Panels the user collapsed (compact mode only), keyed by `type:id`. */
const collapsed = new Set<string>();

/**
 * Compact edge: when one end is the panel's own object, drop that redundant
 * root chip and show only the edge label + the neighbour, so every link fits on
 * one short inline pill and many pills share a row.
 */
function compactEdge(e: RelEdge, type: string, id: string): TemplateResult {
  const fromRoot = e.fromType === type && e.fromId === id;
  const toRoot = e.toType === type && e.toId === id;
  const label = html`<span style="font-size:10px; color:rgba(245,245,244,0.55); white-space:nowrap;"
    >${edgeName(e.edge)}</span
  >`;
  const inner = fromRoot
    ? html`${label}<span style="font-size:10px; color:rgba(245,245,244,0.4);">→</span>${nodeChip({ type: e.toType, id: e.toId }, false, true)}`
    : toRoot
      ? html`${nodeChip({ type: e.fromType, id: e.fromId }, false, true)}<span style="font-size:10px; color:rgba(245,245,244,0.4);">→</span>${label}`
      : html`${nodeChip({ type: e.fromType, id: e.fromId }, false, true)}${label}<span
            style="font-size:10px; color:rgba(245,245,244,0.4);"
            >→</span
          >${nodeChip({ type: e.toType, id: e.toId }, false, true)}`;
  return html`<span
    style="display:inline-flex; align-items:center; gap:4px; box-sizing:border-box; height:22px; max-width:100%; padding:0 6px 0 2px; border:1px solid rgba(255,255,255,0.06); border-radius:999px; background:rgba(255,255,255,0.02);"
    >${inner}</span
  >`;
}

/**
 * Render the Related panel for one object. Kicks a lazy load on first render and
 * caches the neighborhood per (type,id).
 */
export function renderRelatedPanel(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: { title?: string; compact?: boolean } = {},
): TemplateResult {
  if (!id) return nothing as unknown as TemplateResult;
  const k = keyFor(type, id);
  const compact = !!opts.compact;
  const isCollapsed = compact && collapsed.has(k);
  let entry = cache.get(k);
  if (!entry) {
    entry = { loading: false, loaded: false, graph: null, error: null };
    cache.set(k, entry);
    void loadGraph(app, client, type, id);
  }

  const title = opts.title || "Related";
  const g = entry.graph;
  const edges = g?.edges ?? [];

  const head = html`<div
    style="display:flex; align-items:center; gap:8px; margin:${compact ? (isCollapsed ? "0" : "0 0 6px") : "6px 0 8px"}; color:#fbbf24; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; min-width:0;"
  >
    ${compact
      ? html`<button
          @click=${() => {
            if (collapsed.has(k)) collapsed.delete(k);
            else collapsed.add(k);
            app.requestUpdate?.();
          }}
          aria-expanded=${String(!isCollapsed)}
          title=${isCollapsed ? "Show relations" : "Hide relations"}
          style="display:inline-flex; align-items:center; gap:6px; min-width:0; background:none; border:none; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer;"
        >
          <span style="font-size:9px; width:8px;">${isCollapsed ? "▸" : "▾"}</span>
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🔗 ${title}</span>
        </button>`
      : html`🔗 ${title}`}
    ${edges.length ? html`<span style="color:rgba(245,245,244,0.5); font-weight:500;">${edges.length}</span>` : nothing}
    <button
      @click=${() => {
        invalidateRelated(type, id);
        app.requestUpdate?.();
      }}
      title="Refresh relations"
      style="margin-left:auto; background:none; border:1px solid rgba(255,255,255,0.14); color:rgba(245,245,244,0.6); border-radius:6px; font-size:10px; padding:2px 8px; cursor:pointer;"
    >↻</button>
  </div>`;

  let body: TemplateResult;
  if (entry.loading && !entry.loaded) {
    body = html`<div style="font-size:12px; color:rgba(245,245,244,0.5); font-style:italic;">Loading relations…</div>`;
  } else if (entry.error) {
    body = html`<div style="font-size:11px; color:rgba(245,245,244,0.45); font-style:italic;">
      Relations service unavailable (gateway restart required to serve <code>objrel.*</code>).
    </div>`;
  } else if (!edges.length) {
    body = compact
      ? html`<div style="font-size:11px; color:rgba(245,245,244,0.5); font-style:italic;">No links yet.</div>`
      : html`<div style="font-size:12px; color:rgba(245,245,244,0.5); font-style:italic;">
          No links yet — connect this to a client, project, product, person, decision, risk, or commitment to build the graph.
        </div>`;
  } else if (compact) {
    // Wrapping pill cloud with a height cap: many links share a row and the
    // panel never pushes the content below it far down the page (74px = three
    // 22px pill rows + two 4px gaps, so the cap never slices a row in half).
    body = html`<div
      style="display:flex; flex-wrap:wrap; gap:4px 6px; max-height:74px; overflow:auto; overscroll-behavior:contain;"
    >
      ${edges.map((e) => compactEdge(e, type, id))}
    </div>`;
  } else {
    body = html`<div style="display:flex; flex-direction:column; gap:6px;">
      ${edges.map(
        (e) => html`<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          ${nodeChip({ type: e.fromType, id: e.fromId }, e.fromType === type && e.fromId === id)}
          <span style="font-size:10px; color:rgba(245,245,244,0.55);">— ${edgeName(e.edge)} →</span>
          ${nodeChip({ type: e.toType, id: e.toId }, e.toType === type && e.toId === id)}
        </div>`,
      )}
    </div>`;
  }

  return html`<div
    style=${compact
      ? "min-width:0; padding:8px 10px; border:1px solid rgba(251,191,36,0.16); border-radius:10px; background:rgba(255,255,255,0.02);"
      : "grid-column:1/-1; margin-top:10px; padding:10px 12px; border:1px solid rgba(251,191,36,0.16); border-radius:10px; background:rgba(255,255,255,0.02);"}
  >
    ${head}${isCollapsed ? nothing : body}
  </div>`;
}

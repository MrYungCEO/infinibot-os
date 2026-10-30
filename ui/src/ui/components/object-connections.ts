/**
 * Connections panel + generic connected-object focus.
 *
 * The Connections panel is the "profile connection" surface: given any business
 * object it loads its resolved depth-1 neighborhood (`objrel.connections`) and
 * renders a NAVIGABLE card per connection, grouped by type — this client's
 * Opportunities, Projects, Reports, Tasks, Financial Commitments, People, plus
 * the Lead / Funnel it originated from.
 *
 * It differs from `components/related-panel.ts` (which stays where it is, on
 * the Relations tab) in the one way that matters: related-panel renders raw
 * `type:id` edge chips for auditing the graph, this renders resolved, clickable
 * records for WALKING the graph. Clicking a card threads into that object via
 * `components/object-thread-nav.ts` — which is why every focus rendered here
 * carries its OWN Connections panel, and why the surface behaves like a
 * connected graph instead of a set of dead-end pages.
 *
 * DEGRADATION: `objrel.connections` is new, so a gateway that has not been
 * restarted since this shipped will reject it. The panel then says so in one
 * line and falls back to nothing else — it never renders an ambiguous empty
 * state that reads as "this client has no connections".
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { renderCoverBanner } from "./object-cover";
import {
  threadPush,
  threadRelabel,
  threadTypeGlyph,
  threadTypeName,
  type ThreadNode,
} from "./object-thread-nav";

// ── Wire types (mirror src/relations/resolve.ts) ─────────────────────

export interface ResolvedObject {
  type: string;
  id: string;
  label: string;
  subtitle: string;
  status: string;
  tone: "ok" | "warn" | "bad" | "info" | "neutral";
  value: number | null;
  fields: Array<{ label: string; value: string }>;
  updatedAt: number;
  resolved: boolean;
}

export interface Connection extends ResolvedObject {
  relationId: string;
  edge: string;
  direction: "out" | "in";
  edgeMeta: Record<string, unknown>;
}

interface ConnectionGroup {
  type: string;
  label: string;
  items: Connection[];
}

interface ConnectionsPayload {
  root: ResolvedObject;
  groups: ConnectionGroup[];
  total: number;
}

// ── Cache ────────────────────────────────────────────────────────────

interface Entry {
  loading: boolean;
  loaded: boolean;
  data: ConnectionsPayload | null;
  /** Set when the gateway could not serve the RPC at all. */
  unavailable: boolean;
  error: string | null;
}

const cache = new Map<string, Entry>();
const key = (type: string, id: string) => `${type}::${id}`;

export function invalidateConnections(type: string, id: string): void {
  cache.delete(key(type, id));
}

async function load(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
): Promise<void> {
  const e = cache.get(key(type, id));
  if (!e) return;
  e.loading = true;
  e.error = null;
  try {
    const res = (await client.request("objrel.connections", { type, id })) as ConnectionsPayload;
    e.data = res && Array.isArray(res.groups) ? res : { root: res?.root, groups: [], total: 0 };
    e.loaded = true;
    e.unavailable = false;
    // The thread pushed this node with whatever label the card had; once the
    // object resolves for real, patch the crumb so the breadcrumb never shows
    // a raw id. Guarded on `resolved`: an UNresolved root's label IS a
    // shortened id, and relabelling with it would replace a good name (the one
    // the list already knew) with a worse one.
    if (e.data.root?.resolved && e.data.root.label) {
      threadRelabel(type, id, e.data.root.label);
    }
  } catch (err) {
    const msg = String(err);
    e.error = msg;
    // An unserved method reads differently from a genuine failure and needs a
    // different message ("restart the gateway" vs "something went wrong").
    e.unavailable = /method|not found|unknown|unsupported|-3200/i.test(msg);
  } finally {
    e.loading = false;
    app.requestUpdate?.();
  }
}

function entryFor(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
): Entry {
  const k = key(type, id);
  let e = cache.get(k);
  if (!e) {
    e = { loading: false, loaded: false, data: null, unavailable: false, error: null };
    cache.set(k, e);
    void load(app, client, type, id);
  }
  return e;
}

/** Read the resolved root for a (type,id) if it is already cached. */
export function cachedResolvedRoot(type: string, id: string): ResolvedObject | null {
  return cache.get(key(type, id))?.data?.root ?? null;
}

// ── Formatting ───────────────────────────────────────────────────────

function fmtMoney(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `$${n.toLocaleString()}`;
}

function timeAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

const EDGE_PHRASE: Record<string, string> = {
  client_has_opportunity: "opportunity on this client",
  opportunity_becomes_project: "delivered as",
  project_has_task: "task of",
  project_delivers_product: "delivers",
  product_offered_in_opportunity: "offered in",
  decision_guides_task: "guides",
  risk_impacts_task: "impacts",
  commitment_funds_project: "funds",
  task_assigned_to_person: "assigned to",
  issue_relates_task: "relates to",
  report_documents_client: "documents this client",
  report_documents_opportunity: "documents",
  report_documents_project: "documents",
  lead_becomes_client: "converted into this client",
  funnel_captured_lead: "captured the lead",
  relates_to: "related",
};

function edgePhrase(edge: string): string {
  return EDGE_PHRASE[edge] ?? edge.replace(/_/g, " ");
}

// ── Connection card ──────────────────────────────────────────────────

function connectionCard(state: AppViewState, c: Connection): TemplateResult {
  const money = fmtMoney(c.value);
  const inferred = c.edgeMeta?.inferred === true;
  const open = () => {
    if (!c.resolved) return;
    threadPush(state, { type: c.type, id: c.id, label: c.label } satisfies ThreadNode);
  };

  return html`
    <button
      class="crm-conn-card ${c.resolved ? "" : "is-dangling"}"
      ?disabled=${!c.resolved}
      title=${c.resolved ? `Open ${threadTypeName(c.type)}: ${c.label}` : `Unresolved ${c.type}:${c.id}`}
      @click=${open}
    >
      <span class="crm-conn-glyph" aria-hidden="true">${threadTypeGlyph(c.type)}</span>
      <span class="crm-conn-body">
        <span class="crm-conn-title">${c.label}</span>
        ${c.subtitle ? html`<span class="crm-conn-sub">${c.subtitle}</span>` : nothing}
        <span class="crm-conn-meta">
          ${c.status
            ? html`<span class="crm-conn-status tone-${c.tone}">${c.status}</span>`
            : nothing}
          ${money ? html`<span class="crm-conn-value">${money}</span>` : nothing}
          <span class="crm-conn-edge">${edgePhrase(c.edge)}</span>
          ${inferred
            ? html`<span
                class="crm-conn-inferred"
                title=${`Inferred from ${String(c.edgeMeta?.matchedOn ?? "a match")} — no explicit link stored yet`}
                >inferred</span
              >`
            : nothing}
          ${c.updatedAt ? html`<span class="crm-conn-time">${timeAgo(c.updatedAt)}</span>` : nothing}
        </span>
      </span>
      ${c.resolved ? html`<span class="crm-conn-chev" aria-hidden="true">›</span>` : nothing}
    </button>
  `;
}

// ── Connections panel ────────────────────────────────────────────────

/**
 * The Connections panel for one object. Lazy-loads on first render and caches
 * per (type,id) so threading back and forth costs nothing.
 */
export function renderConnectionsPanel(
  state: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: { title?: string; compact?: boolean } = {},
): TemplateResult {
  if (!id) return nothing as unknown as TemplateResult;
  const e = entryFor(state, client, type, id);
  const groups = e.data?.groups ?? [];
  const total = e.data?.total ?? 0;

  const head = html`
    <div class="crm-conn-head">
      <span class="crm-conn-head-title">${opts.title ?? "Connections"}</span>
      ${e.loaded && total > 0 ? html`<span class="crm-conn-count">${total}</span>` : nothing}
      <button
        class="crm-conn-refresh"
        title="Reload connections"
        @click=${() => {
          invalidateConnections(type, id);
          state.requestUpdate?.();
        }}
      >
        ↻
      </button>
    </div>
  `;

  let body: TemplateResult;
  if (e.loading && !e.loaded) {
    body = html`<div class="crm-conn-note">Resolving the connection graph…</div>`;
  } else if (e.unavailable) {
    body = html`<div class="crm-conn-note is-warn">
      Connection resolution isn't being served yet — the gateway needs a restart to
      expose <code>objrel.connections</code>. Existing links are still visible on the
      Relations tab.
    </div>`;
  } else if (e.error) {
    body = html`<div class="crm-conn-note is-warn">Couldn't load connections — ${e.error}</div>`;
  } else if (!groups.length) {
    body = html`<div class="crm-conn-note">
      Nothing linked yet. Connect an opportunity, project, report, commitment or person
      and it will show up here as a card you can open.
    </div>`;
  } else {
    body = html`
      <div class="crm-conn-groups">
        ${groups.map(
          (g) => html`
            <section class="crm-conn-group">
              <header class="crm-conn-group-head">
                <span class="crm-conn-group-glyph" aria-hidden="true">
                  ${threadTypeGlyph(g.type)}
                </span>
                <span class="crm-conn-group-label">${g.label}</span>
                <span class="crm-conn-group-count">${g.items.length}</span>
              </header>
              <div class="crm-conn-list">${g.items.map((c) => connectionCard(state, c))}</div>
            </section>
          `,
        )}
      </div>
    `;
  }

  return html`<div class="crm-conn-panel ${opts.compact ? "is-compact" : ""}">${head}${body}</div>`;
}

// ── Generic connected-object focus ───────────────────────────────────

/**
 * The focus view for any object a user threaded INTO from a record.
 *
 * Deliberately generic rather than one bespoke page per type: the shape a user
 * needs mid-thread is always the same (what is this, what state is it in, what
 * are its properties, what else is it connected to), and the resolver already
 * returns exactly that. A type that later earns a bespoke page can be branched
 * out here without disturbing the thread mechanics.
 */
export function renderConnectedFocus(
  state: AppViewState,
  client: GatewayBrowserClient,
  node: ThreadNode,
): TemplateResult {
  const e = entryFor(state, client, node.type, node.id);
  const obj = e.data?.root ?? null;
  const label = obj?.label || node.label;
  const money = fmtMoney(obj?.value ?? null);

  if (e.unavailable) {
    return html`
      <div class="crm-focus">
        <div class="crm-conn-note is-warn">
          Can't open this ${threadTypeName(node.type).toLowerCase()} — the gateway needs a
          restart to serve <code>objrel.object</code> / <code>objrel.connections</code>.
        </div>
      </div>
    `;
  }

  return html`
    <div class="crm-focus">
      ${renderCoverBanner(state, client, node.type, node.id, {
        height: 160,
        seed: node.id || label,
        radius: "14px",
      })}

      <header class="crm-focus-head">
        <span class="crm-focus-eyebrow">
          <span class="crm-focus-glyph">${threadTypeGlyph(node.type)}</span>
          ${threadTypeName(node.type)}
        </span>
        <h2 class="crm-focus-title">${e.loading && !obj ? "Loading…" : label}</h2>
        <div class="crm-focus-chips">
          ${obj?.status
            ? html`<span class="crm-conn-status tone-${obj.tone}">${obj.status}</span>`
            : nothing}
          ${obj?.subtitle ? html`<span class="crm-focus-chip">${obj.subtitle}</span>` : nothing}
          ${money ? html`<span class="crm-focus-chip is-value">${money}</span>` : nothing}
          ${obj?.updatedAt
            ? html`<span class="crm-focus-chip is-muted">updated ${timeAgo(obj.updatedAt)}</span>`
            : nothing}
        </div>
      </header>

      ${obj && !obj.resolved
        ? html`<div class="crm-conn-note is-warn">
            This link points at <code>${node.type}:${node.id}</code>, but no record with that
            id exists any more — the edge is dangling.
          </div>`
        : nothing}

      ${obj?.fields?.length
        ? html`
            <section class="crm-focus-props">
              <div class="crm-conn-head"><span class="crm-conn-head-title">Properties</span></div>
              <dl class="crm-focus-prop-list">
                ${obj.fields.map(
                  (f) => html`
                    <div class="crm-focus-prop">
                      <dt>${f.label}</dt>
                      <dd>${f.value}</dd>
                    </div>
                  `,
                )}
              </dl>
            </section>
          `
        : nothing}

      ${renderConnectionsPanel(state, client, node.type, node.id, {
        title: `Connected to this ${threadTypeName(node.type).toLowerCase()}`,
      })}
    </div>
  `;
}

// ── Styles ───────────────────────────────────────────────────────────

/**
 * Gold-on-obsidian styling for the thread bar, connection cards and generic
 * focus. Exported as one block (rather than per-component) so a host view
 * mounts the whole navigable-graph surface with a single include.
 */
export const objectConnectionsStyles = html`
  <style>
    /* ── Thread breadcrumb ─────────────────────────────────── */
    .crm-thread-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 8px 12px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent),
        rgba(255, 255, 255, 0.02)
      );
    }
    .crm-thread-exit,
    .crm-thread-back {
      appearance: none;
      cursor: pointer;
      flex: none;
      background: color-mix(in srgb, #fff 3%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: rgba(255, 255, 255, 0.8);
      font: 600 10px "JetBrains Mono", monospace;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 6px 12px;
      border-radius: 9px;
      transition: all 140ms ease;
    }
    .crm-thread-exit:hover,
    .crm-thread-back:hover {
      border-color: color-mix(in srgb, var(--g-primary) 46%, transparent);
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    .crm-thread-crumbs {
      list-style: none;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 2px;
      margin: 0;
      padding: 0;
      min-width: 0;
    }
    .crm-thread-crumb-item {
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }
    .crm-thread-sep {
      color: rgba(255, 255, 255, 0.28);
      font-size: 13px;
      padding: 0 4px;
    }
    .crm-thread-crumb {
      appearance: none;
      background: none;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 4px 9px;
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      max-width: 260px;
      cursor: pointer;
      font-family: "JetBrains Mono", monospace;
      transition: all 130ms ease;
    }
    button.crm-thread-crumb:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 26%, transparent);
    }
    .crm-thread-crumb.is-current {
      background: color-mix(in srgb, var(--g-primary) 13%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      cursor: default;
    }
    .crm-thread-glyph {
      color: var(--g-primary);
      font-size: 10px;
      flex: none;
    }
    .crm-thread-kind {
      color: rgba(255, 255, 255, 0.42);
      font-size: 9px;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      flex: none;
    }
    .crm-thread-label {
      color: rgba(255, 255, 255, 0.9);
      font-size: 11.5px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .crm-thread-crumb.is-current .crm-thread-label {
      color: var(--g-primary);
    }
    .crm-thread-depth {
      margin-left: auto;
      color: rgba(255, 255, 255, 0.35);
      font: 500 9.5px "JetBrains Mono", monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      flex: none;
    }

    /* ── Connections panel ─────────────────────────────────── */
    .crm-conn-panel {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: linear-gradient(160deg, rgba(24, 20, 10, 0.42), rgba(10, 10, 12, 0.5));
    }
    .crm-conn-panel.is-compact {
      padding: 12px 14px;
      gap: 9px;
    }
    .crm-conn-head {
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .crm-conn-head-title {
      color: color-mix(in srgb, var(--g-primary) 82%, #fafafa);
      font: 700 10.5px "JetBrains Mono", monospace;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }
    .crm-conn-count {
      color: rgba(255, 255, 255, 0.5);
      font: 600 10px "JetBrains Mono", monospace;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      padding: 1px 8px;
    }
    .crm-conn-refresh {
      margin-left: auto;
      appearance: none;
      cursor: pointer;
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: rgba(255, 255, 255, 0.55);
      border-radius: 7px;
      font-size: 11px;
      line-height: 1;
      padding: 4px 9px;
      transition: all 130ms ease;
    }
    .crm-conn-refresh:hover {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    }
    .crm-conn-note {
      color: rgba(255, 255, 255, 0.48);
      font-size: 11.5px;
      line-height: 1.6;
      font-style: italic;
    }
    .crm-conn-note.is-warn {
      color: #fbbf7a;
      font-style: normal;
    }
    .crm-conn-note code {
      font-family: "JetBrains Mono", monospace;
      font-size: 10.5px;
      background: rgba(255, 255, 255, 0.07);
      border-radius: 4px;
      padding: 1px 5px;
    }

    .crm-conn-groups {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
      align-items: start;
    }
    .crm-conn-group {
      display: flex;
      flex-direction: column;
      gap: 7px;
      min-width: 0;
    }
    .crm-conn-group-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding-bottom: 5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .crm-conn-group-glyph {
      color: var(--g-primary);
      font-size: 10px;
    }
    .crm-conn-group-label {
      color: rgba(255, 255, 255, 0.72);
      font: 600 10px "JetBrains Mono", monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .crm-conn-group-count {
      margin-left: auto;
      color: rgba(255, 255, 255, 0.4);
      font: 600 10px "JetBrains Mono", monospace;
    }
    .crm-conn-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .crm-conn-card {
      appearance: none;
      cursor: pointer;
      text-align: left;
      width: 100%;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 11px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      background: rgba(255, 255, 255, 0.025);
      transition:
        border-color 140ms ease,
        background 140ms ease,
        transform 140ms ease;
    }
    .crm-conn-card:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--g-primary) 38%, transparent);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      transform: translateX(2px);
    }
    .crm-conn-card:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--g-primary) 60%, transparent);
      outline-offset: 2px;
    }
    .crm-conn-card.is-dangling {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .crm-conn-glyph {
      color: var(--g-primary);
      font-size: 11px;
      line-height: 1.5;
      flex: none;
    }
    .crm-conn-body {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      flex: 1;
    }
    .crm-conn-title {
      color: rgba(255, 255, 255, 0.93);
      font: 600 12px "JetBrains Mono", monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .crm-conn-sub {
      color: rgba(255, 255, 255, 0.45);
      font-size: 10.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .crm-conn-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
    }
    .crm-conn-status {
      font: 600 9px "JetBrains Mono", monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid currentColor;
    }
    .crm-conn-status.tone-ok {
      color: #4ade80;
    }
    .crm-conn-status.tone-warn {
      color: #fb923c;
    }
    .crm-conn-status.tone-bad {
      color: #f87171;
    }
    .crm-conn-status.tone-info {
      color: var(--g-primary);
    }
    .crm-conn-status.tone-neutral {
      color: rgba(255, 255, 255, 0.45);
    }
    .crm-conn-value {
      color: color-mix(in srgb, var(--g-primary) 85%, #fafafa);
      font: 700 10.5px "JetBrains Mono", monospace;
    }
    .crm-conn-edge {
      color: rgba(255, 255, 255, 0.34);
      font-size: 9.5px;
      letter-spacing: 0.04em;
    }
    .crm-conn-inferred {
      color: #a78bfa;
      border: 1px solid color-mix(in srgb, #a78bfa 40%, transparent);
      border-radius: 999px;
      font: 600 8.5px "JetBrains Mono", monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 1px 6px;
    }
    .crm-conn-time {
      color: rgba(255, 255, 255, 0.3);
      font-size: 9.5px;
      margin-left: auto;
    }
    .crm-conn-chev {
      color: rgba(255, 255, 255, 0.3);
      font-size: 16px;
      line-height: 1;
      flex: none;
      align-self: center;
    }
    .crm-conn-card:hover:not(:disabled) .crm-conn-chev {
      color: var(--g-primary);
    }

    /* ── Generic connected focus ───────────────────────────── */
    .crm-focus {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding-bottom: 24px;
    }
    .crm-focus-head {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .crm-focus-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: rgba(255, 255, 255, 0.42);
      font: 600 9.5px "JetBrains Mono", monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .crm-focus-glyph {
      color: var(--g-primary);
      font-size: 11px;
    }
    .crm-focus-title {
      margin: 0;
      color: #fff;
      font: 800 24px "JetBrains Mono", monospace;
      line-height: 1.2;
      letter-spacing: -0.01em;
    }
    .crm-focus-chips {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .crm-focus-chip {
      color: rgba(255, 255, 255, 0.72);
      font: 500 10.5px "JetBrains Mono", monospace;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      padding: 3px 10px;
    }
    .crm-focus-chip.is-value {
      color: color-mix(in srgb, var(--g-primary) 88%, #fff);
      border-color: color-mix(in srgb, var(--g-primary) 34%, transparent);
      font-weight: 700;
    }
    .crm-focus-chip.is-muted {
      color: rgba(255, 255, 255, 0.38);
      border-color: transparent;
      background: none;
      padding-left: 2px;
    }
    .crm-focus-props {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px 18px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      background: linear-gradient(160deg, rgba(24, 20, 10, 0.36), rgba(10, 10, 12, 0.46));
    }
    .crm-focus-prop-list {
      margin: 0;
      display: flex;
      flex-direction: column;
    }
    .crm-focus-prop {
      display: grid;
      grid-template-columns: 170px 1fr;
      gap: 14px;
      align-items: baseline;
      padding: 7px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    }
    .crm-focus-prop:last-child {
      border-bottom: none;
    }
    .crm-focus-prop dt {
      color: rgba(255, 255, 255, 0.4);
      font: 500 10px "JetBrains Mono", monospace;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }
    .crm-focus-prop dd {
      margin: 0;
      color: rgba(255, 255, 255, 0.88);
      font-size: 12px;
      line-height: 1.55;
      word-break: break-word;
    }
    /* ── Activity thread ───────────────────────────────────── */
    .crm-thread-panel {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 16px 18px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: linear-gradient(160deg, rgba(24, 20, 10, 0.42), rgba(10, 10, 12, 0.5));
    }
    .crm-thread-composer {
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
      background: rgba(255, 255, 255, 0.028);
    }
    .crm-thread-type-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .crm-thread-type {
      appearance: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      color: rgba(255, 255, 255, 0.6);
      font: 600 10px "JetBrains Mono", monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 5px 12px;
      transition: all 140ms ease;
    }
    .crm-thread-type:hover {
      color: rgba(255, 255, 255, 0.9);
      border-color: color-mix(in srgb, var(--g-primary) 32%, transparent);
    }
    .crm-thread-type.is-active {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    }
    .crm-thread-type-glyph {
      font-size: 10px;
      opacity: 0.85;
    }
    .crm-thread-input {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      background: rgba(0, 0, 0, 0.32);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 9px;
      color: rgba(255, 255, 255, 0.92);
      font: 400 12.5px Inter, system-ui, sans-serif;
      line-height: 1.55;
      padding: 10px 12px;
      transition: border-color 140ms ease;
    }
    .crm-thread-input:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .crm-thread-input::placeholder {
      color: rgba(255, 255, 255, 0.3);
    }
    .crm-thread-composer-foot {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .crm-thread-hint {
      color: rgba(255, 255, 255, 0.32);
      font-size: 10.5px;
    }
    .crm-thread-post {
      margin-left: auto;
      appearance: none;
      cursor: pointer;
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 45%, transparent);
      color: var(--g-primary);
      border-radius: 9px;
      font: 700 10.5px "JetBrains Mono", monospace;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 7px 18px;
      transition: all 140ms ease;
    }
    .crm-thread-post:hover:not(:disabled) {
      background: color-mix(in srgb, var(--g-primary) 24%, transparent);
    }
    .crm-thread-post:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .crm-thread-list {
      list-style: none;
      margin: 0;
      padding: 0 0 0 4px;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    /* The rail. Drawn behind the nodes so each entry reads as a bead on one
       continuous line rather than a stack of unrelated cards. */
    .crm-thread-list::before {
      content: "";
      position: absolute;
      left: 11px;
      top: 6px;
      bottom: 6px;
      width: 1px;
      background: linear-gradient(
        to bottom,
        color-mix(in srgb, var(--g-primary) 34%, transparent),
        rgba(255, 255, 255, 0.05)
      );
    }
    .crm-thread-day {
      position: relative;
      margin: 12px 0 6px 34px;
      color: rgba(255, 255, 255, 0.34);
      font: 600 9px "JetBrains Mono", monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .crm-thread-day:first-child {
      margin-top: 0;
    }
    .crm-thread-entry {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 7px 0;
    }
    .crm-thread-node {
      position: relative;
      z-index: 1;
      flex: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-size: 10px;
      color: var(--g-primary);
      background: #0b0b0d;
      border: 1px solid color-mix(in srgb, var(--g-primary) 38%, transparent);
    }
    .crm-thread-entry.kind-revenue .crm-thread-node {
      color: #4ade80;
      border-color: color-mix(in srgb, #4ade80 42%, transparent);
    }
    .crm-thread-entry.kind-lifecycle .crm-thread-node {
      color: rgba(255, 255, 255, 0.4);
      border-color: rgba(255, 255, 255, 0.14);
    }
    .crm-thread-entry-body {
      min-width: 0;
      flex: 1;
      padding-bottom: 2px;
    }
    .crm-thread-entry-head {
      display: flex;
      align-items: baseline;
      gap: 9px;
    }
    .crm-thread-entry-kind {
      color: var(--g-primary);
      font: 700 9.5px "JetBrains Mono", monospace;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .crm-thread-entry.kind-lifecycle .crm-thread-entry-kind {
      color: rgba(255, 255, 255, 0.4);
    }
    .crm-thread-entry-accent {
      color: #4ade80;
      font: 700 11px "JetBrains Mono", monospace;
    }
    .crm-thread-entry-time {
      margin-left: auto;
      color: rgba(255, 255, 255, 0.3);
      font: 400 10px "JetBrains Mono", monospace;
      flex: none;
    }
    .crm-thread-entry-text {
      margin-top: 3px;
      color: rgba(255, 255, 255, 0.86);
      font: 400 12.5px Inter, system-ui, sans-serif;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .crm-thread-entry.kind-lifecycle .crm-thread-entry-text {
      color: rgba(255, 255, 255, 0.45);
      font-size: 11.5px;
    }

    .crm-page-connections {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    @media (max-width: 720px) {
      .crm-conn-groups {
        grid-template-columns: 1fr;
      }
      .crm-focus-prop {
        grid-template-columns: 1fr;
        gap: 2px;
      }
      .crm-focus-title {
        font-size: 19px;
      }
    }
  </style>
`;

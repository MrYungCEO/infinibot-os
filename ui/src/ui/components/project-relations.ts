/**
 * Project Relations section — the project board's view of its connections.
 *
 * Projects can carry a LOT of links (a parent project with ~90 sub-projects
 * plus dozens of reports is real data), so this section is built to stay small:
 *
 *  - One header button with the total count. Collapsed by default once a
 *    project has more than {@link AUTO_COLLAPSE_OVER} relations; the user's
 *    open/closed choice is remembered per project (localStorage).
 *  - When open: a filter box, then one group per type (Projects, Tasks,
 *    Reports, People…) with its own collapse toggle, at most
 *    {@link GROUP_CAP} compact rows per group and a "Show all (N)" link.
 *  - The body has a max-height with its own internal scroll, so even "show
 *    all" never pushes the task board far down the page.
 *
 * Data comes from `objrel.connections` (resolved names, grouped, depth 1) —
 * the same resolver the CRM Connections panel uses. If the gateway predates
 * that RPC, the section falls back to the raw edge cloud from related-panel.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { icons } from "../icons";
import { renderRelatedPanel } from "./related-panel";

interface Conn {
  type: string;
  id: string;
  label: string;
  subtitle: string;
  status: string;
  tone: "ok" | "warn" | "bad" | "info" | "neutral";
  edge: string;
  direction: "out" | "in";
  edgeMeta?: Record<string, unknown>;
  updatedAt: number;
  resolved: boolean;
}
interface Group {
  type: string;
  label: string;
  items: Conn[];
}
interface Payload {
  groups: Group[];
  total: number;
}

interface Entry {
  loading: boolean;
  loaded: boolean;
  data: Payload | null;
  unavailable: boolean;
  error: string | null;
}

/** More relations than this → the section starts collapsed. */
export const AUTO_COLLAPSE_OVER = 8;
/** Rows shown per group before "Show all (N)". */
export const GROUP_CAP = 6;

const cache = new Map<string, Entry>();
const key = (type: string, id: string) => `${type}:${id}`;

/** Per-project UI state that lives only for this page session. */
const query = new Map<string, string>();
const closedGroups = new Set<string>();
const expandedGroups = new Set<string>();

const STORE_KEY = "ib.projectRelations.open";

function readOpenPrefs(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeOpenPref(k: string, open: boolean): void {
  try {
    const prefs = readOpenPrefs();
    prefs[k] = open;
    // Keep the map bounded — newest choices win.
    const keys = Object.keys(prefs);
    if (keys.length > 300) for (const old of keys.slice(0, keys.length - 300)) delete prefs[old];
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage disabled — the toggle still works for this session */
  }
}

/** Whether the section is open: the user's remembered choice, else size-based. */
export function relationsOpenFor(k: string, total: number): boolean {
  const pref = readOpenPrefs()[k];
  return typeof pref === "boolean" ? pref : total <= AUTO_COLLAPSE_OVER;
}

export function invalidateProjectRelations(type: string, id: string): void {
  cache.delete(key(type, id));
}

async function load(app: AppViewState, client: GatewayBrowserClient, type: string, id: string) {
  const e = cache.get(key(type, id));
  if (!e) return;
  e.loading = true;
  e.error = null;
  try {
    const res = (await client.request("objrel.connections", { type, id })) as Payload;
    e.data = res && Array.isArray(res.groups) ? res : { groups: [], total: 0 };
    e.loaded = true;
    e.unavailable = false;
  } catch (err) {
    const msg = String(err);
    e.error = msg;
    e.unavailable = /method|not found|unknown|unsupported|-3200/i.test(msg);
  } finally {
    e.loading = false;
    app.requestUpdate?.();
  }
}

const TYPE_ICON: Record<string, TemplateResult> = {
  project: icons.folder,
  task: icons.checkCircle,
  report: icons.fileText,
  client: icons.briefcase,
  opportunity: icons.target,
  product: icons.layers,
  decision: icons.lightbulb,
  risk: icons.alert,
  commitment: icons.dollarSign,
  person: icons.person,
  issue: icons.bug,
  lead: icons.sparkles,
  funnel: icons.filter,
  note: icons.penLine,
  agent: icons.bot,
};
const typeIcon = (t: string) => TYPE_ICON[t] ?? icons.link;

const EDGE_SHORT: Record<string, string> = {
  opportunity_becomes_project: "from opportunity",
  project_has_task: "task",
  project_delivers_product: "delivers",
  commitment_funds_project: "funds",
  report_documents_project: "documents",
  relates_to: "related",
};
const edgeShort = (e: string) => EDGE_SHORT[e] ?? e.replace(/_/g, " ");

/** Stable display order: the things people open most often first. */
const GROUP_ORDER = ["project", "task", "report", "note", "agent", "opportunity", "client", "person"];
const groupRank = (t: string) => {
  const i = GROUP_ORDER.indexOf(t);
  return i < 0 ? GROUP_ORDER.length : i;
};

function timeAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface ProjectRelationsOpts {
  title?: string;
  /** Open a connected object (e.g. jump to a linked project's board). */
  onOpen?: (type: string, id: string) => void;
  /** Types the host can open; rows of other types render as plain text. */
  openable?: readonly string[];
}

function row(c: Conn, opts: ProjectRelationsOpts): TemplateResult {
  const canOpen = c.resolved && !!opts.onOpen && (opts.openable ?? []).includes(c.type);
  const inferred = c.edgeMeta?.inferred === true;
  const inner = html`
    <span class="pjr-row-ico" aria-hidden="true">${typeIcon(c.type)}</span>
    <span class="pjr-row-title">${c.label || "Untitled"}</span>
    ${c.status ? html`<span class="pjr-row-status tone-${c.tone}">${c.status}</span>` : nothing}
    <span class="pjr-row-meta"
      >${edgeShort(c.edge)}${inferred ? " · inferred" : ""}${c.updatedAt ? ` · ${timeAgo(c.updatedAt)}` : ""}</span
    >
  `;
  return canOpen
    ? html`<button
        class="pjr-row is-link"
        title=${`Open ${c.label}`}
        @click=${() => opts.onOpen?.(c.type, c.id)}
      >
        ${inner}<span class="pjr-row-chev" aria-hidden="true">${icons.chevronRight}</span>
      </button>`
    : html`<div class="pjr-row ${c.resolved ? "" : "is-dangling"}" title=${c.subtitle || c.label}>
        ${inner}
      </div>`;
}

/**
 * Render the Relations section for a project (or any object type the
 * resolver knows). Lazy-loads on first render and caches per (type, id).
 */
export function renderProjectRelations(
  app: AppViewState,
  client: GatewayBrowserClient,
  type: string,
  id: string,
  opts: ProjectRelationsOpts = {},
): TemplateResult {
  if (!id) return nothing as unknown as TemplateResult;
  const k = key(type, id);
  let e = cache.get(k);
  if (!e) {
    e = { loading: false, loaded: false, data: null, unavailable: false, error: null };
    cache.set(k, e);
    void load(app, client, type, id);
  }

  // Pre-restart gateway: keep the old (raw edge) panel rather than nothing.
  if (e.unavailable) {
    return renderRelatedPanel(app, client, type, id, { title: opts.title ?? "Relations", compact: true });
  }

  const groups = [...(e.data?.groups ?? [])].sort((a, b) => groupRank(a.type) - groupRank(b.type));
  const total = e.data?.total ?? groups.reduce((n, g) => n + g.items.length, 0);
  const open = e.loaded ? relationsOpenFor(k, total) : false;
  const q = (query.get(k) ?? "").trim().toLowerCase();
  const title = opts.title ?? "Relations";

  const toggle = () => {
    writeOpenPref(k, !open);
    app.requestUpdate?.();
  };

  const head = html`
    <div class="pjs-head">
      <button
        class="pjs-toggle"
        aria-expanded=${String(open)}
        ?disabled=${!e.loaded}
        title=${open ? "Collapse relations" : "Expand relations"}
        @click=${toggle}
      >
        <span class="pjs-chev ${open ? "is-open" : ""}" aria-hidden="true">${icons.chevronRight}</span>
        <span class="pjs-ico" aria-hidden="true">${icons.network}</span>
        <span class="pjs-title">${title}</span>
        ${e.loaded ? html`<span class="pjs-count">${total}</span>` : nothing}
      </button>
      ${!open && e.loaded && groups.length
        ? html`<span class="pjs-summary" @click=${toggle}>
            ${groups.map(
              (g) => html`<span class="pjs-sum-chip" title=${g.label}
                ><span aria-hidden="true">${typeIcon(g.type)}</span>${g.items.length}</span
              >`,
            )}
          </span>`
        : nothing}
      <button
        class="pjs-icon-btn"
        title="Reload relations"
        aria-label="Reload relations"
        @click=${() => {
          invalidateProjectRelations(type, id);
          app.requestUpdate?.();
        }}
      >
        ${icons.refresh}
      </button>
    </div>
  `;

  let body: TemplateResult | typeof nothing = nothing;
  if (e.loading && !e.loaded) {
    body = html`<div class="pjs-note">Loading relations…</div>`;
  } else if (e.error && !e.loaded) {
    body = html`<div class="pjs-note is-warn">Couldn't load relations — ${e.error}</div>`;
  } else if (open && !total) {
    body = html`<div class="pjs-note">No links yet. Linked projects, tasks, reports and people show up here.</div>`;
  } else if (open) {
    const filtered = groups
      .map((g) => ({
        ...g,
        items: q
          ? g.items.filter((c) =>
              `${c.label} ${c.subtitle} ${c.status} ${g.label}`.toLowerCase().includes(q),
            )
          : g.items,
      }))
      .filter((g) => g.items.length);
    const shown = filtered.reduce((n, g) => n + g.items.length, 0);
    body = html`
      ${total > GROUP_CAP
        ? html`<div class="pjs-tools">
            <label class="pjs-search">
              <span aria-hidden="true">${icons.search}</span>
              <input
                type="search"
                placeholder="Filter relations…"
                aria-label="Filter relations"
                .value=${query.get(k) ?? ""}
                @input=${(ev: Event) => {
                  query.set(k, (ev.target as HTMLInputElement).value);
                  app.requestUpdate?.();
                }}
              />
            </label>
            ${q ? html`<span class="pjs-tools-meta">${shown} of ${total}</span>` : nothing}
          </div>`
        : nothing}
      <div class="pjs-scroll pjr-groups">
        ${filtered.length
          ? filtered.map((g) => {
              const gk = `${k}|${g.type}`;
              const gOpen = !closedGroups.has(gk);
              const all = !!q || expandedGroups.has(gk);
              const items = all ? g.items : g.items.slice(0, GROUP_CAP);
              return html`<section class="pjr-group">
                <button
                  class="pjr-group-head"
                  aria-expanded=${String(gOpen)}
                  @click=${() => {
                    if (gOpen) closedGroups.add(gk);
                    else closedGroups.delete(gk);
                    app.requestUpdate?.();
                  }}
                >
                  <span class="pjs-chev ${gOpen ? "is-open" : ""}" aria-hidden="true">${icons.chevronRight}</span>
                  <span class="pjr-group-ico" aria-hidden="true">${typeIcon(g.type)}</span>
                  <span class="pjr-group-label">${g.label}</span>
                  <span class="pjs-count">${g.items.length}</span>
                </button>
                ${gOpen
                  ? html`<div class="pjr-list">${items.map((c) => row(c, opts))}</div>
                      ${!q && g.items.length > GROUP_CAP
                        ? html`<button
                            class="pjs-more"
                            @click=${() => {
                              if (all) expandedGroups.delete(gk);
                              else expandedGroups.add(gk);
                              app.requestUpdate?.();
                            }}
                          >
                            ${all ? "Show fewer" : `Show all (${g.items.length})`}
                          </button>`
                        : nothing}`
                  : nothing}
              </section>`;
            })
          : html`<div class="pjs-note">Nothing matches “${query.get(k)}”.</div>`}
      </div>
    `;
  }

  return html`<section class="pjs-panel pjr-panel ${open ? "is-open" : "is-closed"}" aria-label=${title}>
    ${head}${body}
  </section>`;
}

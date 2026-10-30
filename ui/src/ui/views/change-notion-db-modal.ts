/**
 * <change-notion-db-modal> — single-role swap modal.
 *
 * The drop-in widget that lives next to the "sync to Notion" button on
 * Projects/Tasks/CRM pages. Opens against a specific role; lets the
 * operator swap which Notion DB drives that role and reconcile any rows
 * that overlap between the new DB and the existing local data.
 *
 * Flow:
 *   1. Discover    — list every Notion DB the integration sees, with the
 *                    current binding highlighted.
 *   2. Map fields  — preview the chosen DB's schema against the role and
 *                    edit the proposed field map.
 *   3. Overlaps    — pull rows from the new DB, match by title against
 *                    local rows, render a per-row resolution table.
 *   4. Relations   — auto-import any related DBs that aren't yet bound.
 *   5. Commit      — changeTarget + mergeRows + initial pull, all in one go.
 *
 * RPCs consumed (all gated through the gateway / setup-ui dispatch):
 *   notion.import.listDatabases
 *   notion.import.preview
 *   notion.import.findOverlaps
 *   notion.import.scanRelations
 *   notion.bindings.changeTarget
 *   notion.import.mergeRows
 *   notion.import.commit            (for related DBs auto-imported on commit)
 */
import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";

export type ChangeRoleId =
  | "projects"
  | "tasks"
  | "clients"
  | "leads"
  | "companies"
  | "deals"
  | "contacts"
  | "custom";

type Step = "discover" | "mapping" | "overlaps" | "relations" | "commit";

interface DiscoveredDb {
  id: string;
  title: string;
  url?: string;
  propertyCount: number;
  isSystemManaged: boolean;
  propertyNames: string[];
  suggestedRole: ChangeRoleId;
  existingBinding: {
    role: ChangeRoleId;
    fieldMap: Record<string, string>;
  } | null;
}

interface PreviewResult {
  dbId: string;
  role: ChangeRoleId;
  propertyNames: string[];
  diff: {
    diffs: Array<{
      canonical: string;
      type: string;
      existingAlias: string | null;
      missing: boolean;
      typeMismatch: boolean;
      actualType: string | null;
    }>;
    satisfiesRequired: boolean;
  } | null;
  proposedFieldMap: Record<string, string>;
}

interface Overlap {
  notionPageId: string;
  notionTitle: string;
  notionArchived: boolean;
  localRowId: string;
  localTitle: string;
  matchScore: number;
  matchReason: string;
}

interface OverlapsResult {
  overlaps: Overlap[];
  notionOnly: Array<{ notionPageId: string; notionTitle: string }>;
  localOnly: Array<{ localRowId: string; localTitle: string }>;
  notionPageCount: number;
  localRowCount: number;
}

interface RelationLink {
  sourceDbId: string;
  sourceProp: string;
  targetDbId: string;
  targetTitle: string;
  targetIsKnown: boolean;
  targetRole: string | null;
}

export interface ChangeNotionDbModalState {
  /** Role this modal is locked to. Set when the parent opens it. */
  role: ChangeRoleId;
  /** The currently bound notion db id, if any — shown so the user knows what they're replacing. */
  currentNotionDbId: string | null;
  open: boolean;
  step: Step;
  busy: boolean;
  error: string | null;

  discovered: DiscoveredDb[];
  selectedDbId: string | null;
  preview: PreviewResult | null;
  fieldMap: Record<string, string>;
  applyPatch: boolean;
  conflictPolicy: "queue" | "last-write-wins";

  overlaps: OverlapsResult | null;
  /** Per-overlap operator decision. Default "merge" so the conflict queue handles it. */
  overlapDecisions: Record<string, "keep-local" | "keep-notion" | "merge">;

  relations: RelationLink[];
  importRelatedByDb: Record<string, boolean>;

  commitSummary: { swapped: boolean; merged: number; relatedImported: number } | null;
  /**
   * When true the modal renders as a small floating bar instead of the full
   * dialog, so the operator can refer to the underlying view (database list,
   * project page) without losing modal state. Click the restore button or the
   * collapsed bar itself to reopen.
   */
  collapsed: boolean;
}

export function createChangeNotionDbModalState(role: ChangeRoleId): ChangeNotionDbModalState {
  return {
    role,
    currentNotionDbId: null,
    open: false,
    step: "discover",
    busy: false,
    error: null,
    discovered: [],
    selectedDbId: null,
    preview: null,
    fieldMap: {},
    applyPatch: false,
    conflictPolicy: "queue",
    overlaps: null,
    overlapDecisions: {},
    relations: [],
    importRelatedByDb: {},
    commitSummary: null,
    collapsed: false,
  };
}

function toggleCollapsed(opts: Actions): void {
  opts.state.collapsed = !opts.state.collapsed;
  opts.requestUpdate();
}

interface Actions {
  client: GatewayBrowserClient;
  state: ChangeNotionDbModalState;
  requestUpdate: () => void;
}

async function rpc<T = unknown>(client: GatewayBrowserClient, method: string, params: unknown): Promise<T> {
  const fn = (client as any)?.request || (client as any)?.call || (client as any)?.invoke;
  if (!fn) throw new Error("gateway client has no request/call/invoke method");
  return fn.call(client, method, params) as Promise<T>;
}

/**
 * RPC that survives a short WebSocket drop mid-commit. The change-notion-db
 * wizard fires several RPCs in sequence and the user saw a failure when the
 * gateway socket bounced between the global binding swap (step 1) and the
 * per-business clients hand-off (step 4) — the swap landed, the hand-off
 * threw "gateway not connected", and the rows never pulled. With reconnect
 * typically taking <2s, a short retry loop covers the transient case
 * without papering over real failures (those still surface after the
 * configured budget).
 */
async function rpcResilient<T = unknown>(
  client: GatewayBrowserClient,
  method: string,
  params: unknown,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 1000;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await rpc<T>(client, method, params);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Only retry transient disconnects. Real RPC errors (NOT_FOUND,
      // INVALID_REQUEST, Notion API failures, etc.) should fail fast.
      if (!/not connected|disconnected|socket|timeout/i.test(msg)) throw e;
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function setBusy(state: ChangeNotionDbModalState, busy: boolean): void {
  state.busy = busy;
  if (busy) state.error = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Public open / close
// ─────────────────────────────────────────────────────────────────────────

export async function openChangeNotionDbModal(
  opts: Actions,
  role: ChangeRoleId,
  currentNotionDbId: string | null,
): Promise<void> {
  // Reset to a fresh modal lifecycle so a re-open doesn't leak state from
  // a previous attempt. Keeping the role-bound state lifetime per-open
  // also means we don't stash secrets like the field map across closes.
  Object.assign(opts.state, createChangeNotionDbModalState(role));
  opts.state.currentNotionDbId = currentNotionDbId;
  opts.state.open = true;
  opts.requestUpdate();
  await loadDiscover(opts);
}

export function closeChangeNotionDbModal(opts: Actions): void {
  opts.state.open = false;
  opts.requestUpdate();
}

// ─────────────────────────────────────────────────────────────────────────
// Step actions
// ─────────────────────────────────────────────────────────────────────────

async function loadDiscover(opts: Actions): Promise<void> {
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<{ databases: DiscoveredDb[] }>(opts.client, "notion.import.listDatabases", {});
    console.log("[change-db-modal] notion.import.listDatabases →", {
      count: res.databases?.length ?? 0,
      sample: (res.databases ?? []).slice(0, 3).map((d) => ({ id: d.id, title: d.title })),
    });
    opts.state.discovered = res.databases;
  } catch (e: any) {
    const code = e?.code ?? e?.cause?.code ?? "";
    const msg = e?.message ?? String(e);
    // Map the most common Notion failures to actionable hints. The
    // server-side handler already classifies the error code; we tack on a
    // suggestion so the user knows what to do without digging through logs.
    let hint = "";
    if (code === "NOTION_AUTH_FAILED" || /401|invalid api token/i.test(msg)) {
      hint = " — your Notion API key is invalid or revoked. Re-paste it via /quickstart → Notion step.";
    } else if (code === "NOTION_FORBIDDEN" || /403|restricted_resource/i.test(msg)) {
      hint = " — the integration doesn't have access to any databases. Open Notion → top-right ‘…’ → Connections → add this integration to your databases.";
    } else if (code === "NOTION_RATE_LIMITED" || /429/.test(msg)) {
      hint = " — Notion rate-limited the request. Wait a minute and try again.";
    } else if (code === "NOT_CONFIGURED") {
      hint = " — Notion isn't configured. Run /quickstart and finish the Notion step.";
    }
    opts.state.error = `Discovery failed: ${msg}${hint}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

async function pickDb(opts: Actions, dbId: string): Promise<void> {
  opts.state.selectedDbId = dbId;
  opts.state.step = "mapping";
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<PreviewResult>(opts.client, "notion.import.preview", {
      dbId,
      role: opts.state.role,
    });
    opts.state.preview = res;
    opts.state.fieldMap = { ...res.proposedFieldMap };
    opts.state.applyPatch = res.diff?.satisfiesRequired === false;
  } catch (e: any) {
    opts.state.error = `Preview failed: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

async function goToOverlaps(opts: Actions): Promise<void> {
  if (!opts.state.selectedDbId) return;
  opts.state.step = "overlaps";
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<OverlapsResult>(opts.client, "notion.import.findOverlaps", {
      notionDbId: opts.state.selectedDbId,
      role: opts.state.role,
    });
    opts.state.overlaps = res;
    // Default decision: "merge" (link rows, let conflict queue resolve).
    const dec: Record<string, "keep-local" | "keep-notion" | "merge"> = {};
    for (const o of res.overlaps) dec[o.notionPageId] = "merge";
    opts.state.overlapDecisions = dec;
  } catch (e: any) {
    opts.state.error = `Overlap scan failed: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

async function goToRelations(opts: Actions): Promise<void> {
  if (!opts.state.selectedDbId) return;
  opts.state.step = "relations";
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<{ relations: RelationLink[] }>(opts.client, "notion.import.scanRelations", {
      dbIds: [opts.state.selectedDbId],
    });
    opts.state.relations = res.relations;
    for (const r of res.relations) {
      if (!r.targetIsKnown && opts.state.importRelatedByDb[r.targetDbId] === undefined) {
        opts.state.importRelatedByDb[r.targetDbId] = true;
      }
    }
  } catch (e: any) {
    opts.state.error = `Relation scan failed: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

async function commit(opts: Actions): Promise<void> {
  if (!opts.state.selectedDbId) return;
  setBusy(opts.state, true);
  opts.requestUpdate();
  let merged = 0;
  let relatedImported = 0;
  try {
    // 1. Swap binding. Pass the picked DB's display title so the gateway
    //    can rename the local kanban-projects/kanban-tasks stub to match —
    //    keeps the sidebar showing "2026 Roadmap" instead of "Projects"
    //    after the operator binds projects to a renamed Notion DB.
    const picked = opts.state.discovered.find((d) => d.id === opts.state.selectedDbId);
    await rpc(opts.client, "notion.bindings.changeTarget", {
      role: opts.state.role,
      newNotionDbId: opts.state.selectedDbId,
      oldNotionDbId: opts.state.currentNotionDbId ?? undefined,
      conflictPolicy: opts.state.conflictPolicy,
      newNotionDbTitle: picked?.title ?? undefined,
    });

    // 2. Overlap merge plan.
    const plan = (opts.state.overlaps?.overlaps ?? []).map((o) => ({
      notionPageId: o.notionPageId,
      localRowId: o.localRowId,
      action: opts.state.overlapDecisions[o.notionPageId] ?? "merge",
    }));
    if (
      plan.length > 0 &&
      (opts.state.role === "projects" ||
        opts.state.role === "tasks" ||
        opts.state.role === "clients")
    ) {
      const res = await rpc<{ applied: number }>(opts.client, "notion.import.mergeRows", {
        role: opts.state.role,
        plan,
      });
      merged = res.applied;
    }

    // 3. Auto-import related DBs.
    for (const [targetDbId, importIt] of Object.entries(opts.state.importRelatedByDb)) {
      if (!importIt) continue;
      try {
        const preview = await rpc<PreviewResult>(opts.client, "notion.import.preview", {
          dbId: targetDbId,
          role: "custom",
        });
        await rpc(opts.client, "notion.import.commit", {
          dbId: targetDbId,
          role: "custom",
          fieldMap: preview.proposedFieldMap,
          conflictPolicy: opts.state.conflictPolicy,
          applyPatch: false,
        });
        relatedImported++;
      } catch {
        // Best-effort — operator can re-run for failed rows via the wizard.
      }
    }

    // 4. Per-business CRM hand-off for the clients role.
    //    `notion.bindings.changeTarget` only updates the GLOBAL role
    //    binding + the canonical `clientsDbId` config field. The /clients
    //    page reads from the per-business CRM bridge (biz.crmDatabaseId →
    //    business_role_databases → db_rows). Without these two extra
    //    calls, swapping to a Notion DB with 406 rows leaves the bridge
    //    at 0 rows and the page appears empty even though the binding
    //    looks "connected" everywhere else.
    if (opts.state.role === "clients") {
      try {
        await rpcResilient(opts.client, "business.clients.notion.connect", {
          databaseId: opts.state.selectedDbId,
          databaseName: picked?.title ?? null,
          // businessId omitted on purpose — server falls back to the
          // active business via getCrmBiz().
        });
        const importRes = await rpcResilient<{ imported?: number; updated?: number }>(
          opts.client,
          "business.clients.notion.import",
          {},
        );
        // Fold the freshly-pulled rows into the merged counter so the
        // commit summary card reflects the actual data brought in.
        merged += (importRes.imported ?? 0) + (importRes.updated ?? 0);
      } catch (e: any) {
        // Non-fatal — binding still landed; user can retry via the
        // Clients page's ↓ PULL button. Surface the cause so it's not
        // silent.
        console.warn("[change-notion-db] per-business clients pull failed:", e);
        opts.state.error =
          `Binding swapped, but pulling rows into the Clients page failed: ${e?.message ?? String(e)}. ` +
          `Open /clients and click ↓ PULL to retry.`;
      }
    }

    opts.state.commitSummary = {
      swapped: true,
      merged,
      relatedImported,
    };
    opts.state.step = "commit";
  } catch (e: any) {
    opts.state.error = `Commit failed: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Renders
// ─────────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<ChangeRoleId, string> = {
  projects: "Projects",
  tasks: "Tasks",
  clients: "Clients",
  leads: "Leads",
  companies: "Companies",
  deals: "Deals",
  contacts: "Contacts",
  custom: "Custom",
};

function renderDiscover(opts: Actions): TemplateResult {
  const dbs = opts.state.discovered;
  const filtered = dbs.filter((d) => !d.isSystemManaged || d.id === opts.state.currentNotionDbId);
  // First-fetch loading: busy + nothing rendered yet → skeleton instead of
  // the bare "No candidate databases" message, which otherwise flashes
  // for the entire discovery round-trip.
  const isInitialLoading = opts.state.busy && dbs.length === 0;
  return html`
    <div class="cnd-step">
      <p class="cnd-muted">
        Pick a Notion database to drive your <strong>${ROLE_LABEL[opts.state.role]}</strong>.
        Suggested matches based on names + properties are shown first; system-managed databases are hidden.
      </p>
      ${isInitialLoading
        ? renderDiscoverSkeleton()
        : filtered.length === 0
        ? html`<p class="cnd-empty">No candidate databases. Open the import wizard to connect one first.</p>`
        : html`
            <table class="cnd-table">
              <thead><tr><th></th><th>Database</th><th>Properties</th><th>Status</th></tr></thead>
              <tbody>
                ${filtered.map((db) => {
                  const isCurrent = db.id === opts.state.currentNotionDbId;
                  const isSuggested = db.suggestedRole === opts.state.role;
                  return html`
                    <tr class=${isCurrent ? "cnd-current" : ""}>
                      <td>
                        <button class="cnd-btn cnd-btn-primary" @click=${() => void pickDb(opts, db.id)}>
                          ${isCurrent ? "Re-bind" : "Pick"}
                        </button>
                      </td>
                      <td>
                        <strong>${db.title}</strong>
                        ${db.url ? html`<br /><a class="cnd-link" href=${db.url} target="_blank">open</a>` : nothing}
                      </td>
                      <td>${db.propertyCount}</td>
                      <td>
                        ${isCurrent
                          ? html`<span class="cnd-pill cnd-pill-info">Currently bound</span>`
                          : isSuggested
                            ? html`<span class="cnd-pill cnd-pill-ok">Suggested</span>`
                            : nothing}
                        ${db.existingBinding && !isCurrent
                          ? html`<span class="cnd-pill cnd-pill-warn">Bound to ${db.existingBinding.role}</span>`
                          : nothing}
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          `}
    </div>
  `;
}

/**
 * Skeleton loader shown during the initial `notion.import.listDatabases`
 * fetch. Renders the same row anatomy as the real table (button placeholder,
 * title bar, count bar, status pill) so the layout doesn't pop when the
 * real rows arrive. The shimmer animation is driven by a single keyframe on
 * a translated background-gradient — no JS, no flicker.
 */
function renderDiscoverSkeleton(): TemplateResult {
  // Render five rows; varying widths feel less mechanical than a uniform set.
  const rowWidths: Array<{ title: number; count: number; pill: number }> = [
    { title: 60, count: 32, pill: 78 },
    { title: 78, count: 26, pill: 56 },
    { title: 50, count: 38, pill: 72 },
    { title: 70, count: 30, pill: 64 },
    { title: 56, count: 24, pill: 48 },
  ];
  return html`
    <div class="cnd-skeleton" role="status" aria-live="polite" aria-label="Loading Notion databases">
      <div class="cnd-skeleton-banner">
        <span class="cnd-skeleton-spinner" aria-hidden="true"></span>
        <span>Scanning Notion for available databases…</span>
      </div>
      <table class="cnd-table cnd-skeleton-table" aria-hidden="true">
        <thead><tr><th></th><th>Database</th><th>Properties</th><th>Status</th></tr></thead>
        <tbody>
          ${rowWidths.map(
            (w) => html`
              <tr>
                <td><span class="cnd-skel cnd-skel-btn"></span></td>
                <td><span class="cnd-skel cnd-skel-bar" style="width:${w.title}%"></span></td>
                <td><span class="cnd-skel cnd-skel-bar" style="width:${w.count}%"></span></td>
                <td><span class="cnd-skel cnd-skel-pill" style="width:${w.pill}px"></span></td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderMapping(opts: Actions): TemplateResult {
  const preview = opts.state.preview;
  if (!preview) return html`<div class="cnd-step cnd-muted">Loading preview…</div>`;
  const map = opts.state.fieldMap;
  const rows = preview.diff?.diffs ?? [];
  return html`
    <div class="cnd-step">
      <h4>Map fields</h4>
      <p class="cnd-muted">
        Each canonical field on the left feeds from a Notion property on the right. Type mismatches need to
        be fixed manually in Notion — InfiniBot won't change a property's type for you.
      </p>
      <label class="cnd-check">
        <input
          type="checkbox"
          .checked=${opts.state.applyPatch}
          @change=${(e: Event) => { opts.state.applyPatch = (e.target as HTMLInputElement).checked; opts.requestUpdate(); }}
        />
        Add missing canonical properties to this Notion database on commit
      </label>
      <table class="cnd-table">
        <thead><tr><th>InfiniBot field</th><th>Notion property</th><th>Status</th></tr></thead>
        <tbody>
          ${rows.map((row) => html`
            <tr>
              <td><code>${row.canonical}</code></td>
              <td>
                <select
                  class="cnd-select"
                  .value=${map[row.canonical] ?? ""}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    if (v === "") delete map[row.canonical];
                    else map[row.canonical] = v;
                    opts.state.fieldMap = { ...map };
                    opts.requestUpdate();
                  }}
                >
                  <option value="">— ignore —</option>
                  ${preview.propertyNames.map((n) => html`<option value=${n}>${n}</option>`)}
                </select>
              </td>
              <td>
                ${row.missing
                  ? html`<span class="cnd-pill cnd-pill-warn">Missing in Notion</span>`
                  : row.typeMismatch
                    ? html`<span class="cnd-pill cnd-pill-err">Type ${row.actualType ?? "?"} ≠ ${row.type}</span>`
                    : html`<span class="cnd-pill cnd-pill-ok">OK</span>`}
              </td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function renderOverlaps(opts: Actions): TemplateResult {
  const o = opts.state.overlaps;
  if (!o) return html`<div class="cnd-step cnd-muted">Scanning for overlaps…</div>`;
  return html`
    <div class="cnd-step">
      <h4>Overlap analysis</h4>
      <p class="cnd-muted">
        Scanned <strong>${o.notionPageCount}</strong> Notion rows against
        <strong>${o.localRowCount}</strong> local ${ROLE_LABEL[opts.state.role].toLowerCase()}.
        ${o.overlaps.length} title match${o.overlaps.length === 1 ? "" : "es"} found —
        ${o.notionOnly.length} Notion-only,
        ${o.localOnly.length} local-only.
      </p>
      ${o.overlaps.length === 0
        ? html`<p class="cnd-empty">No overlapping titles. Notion-only rows will arrive via the next pull; local-only rows will be pushed to Notion.</p>`
        : html`
            <table class="cnd-table">
              <thead><tr><th>Title</th><th>Notion side</th><th>Local side</th><th>Decision</th></tr></thead>
              <tbody>
                ${o.overlaps.map((row) => {
                  const decision = opts.state.overlapDecisions[row.notionPageId] ?? "merge";
                  return html`
                    <tr>
                      <td><strong>${row.notionTitle}</strong></td>
                      <td><span class="cnd-mono">${row.notionPageId.slice(0, 8)}…</span>${row.notionArchived ? html` <span class="cnd-pill cnd-pill-warn">archived</span>` : nothing}</td>
                      <td><span class="cnd-mono">${row.localRowId.slice(0, 8)}…</span></td>
                      <td>
                        <select
                          class="cnd-select"
                          .value=${decision}
                          @change=${(e: Event) => {
                            opts.state.overlapDecisions[row.notionPageId] = (e.target as HTMLSelectElement)
                              .value as "keep-local" | "keep-notion" | "merge";
                            opts.requestUpdate();
                          }}
                        >
                          <option value="merge">Link &amp; queue conflicts</option>
                          <option value="keep-local">Keep local (overwrite Notion next push)</option>
                          <option value="keep-notion">Keep Notion (overwrite local next pull)</option>
                        </select>
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          `}
    </div>
  `;
}

function renderRelations(opts: Actions): TemplateResult {
  const grouped: Record<string, RelationLink[]> = {};
  for (const r of opts.state.relations) {
    if (!grouped[r.targetDbId]) grouped[r.targetDbId] = [];
    grouped[r.targetDbId].push(r);
  }
  const targets = Object.entries(grouped);
  return html`
    <div class="cnd-step">
      <h4>Cross-database relations</h4>
      ${targets.length === 0
        ? html`<p class="cnd-empty">No relation columns to resolve.</p>`
        : html`
            <p class="cnd-muted">
              The new database links to these others. Auto-importing them keeps relation columns
              resolvable (Tasks→Projects, Deals→Clients, etc.). Already-bound DBs are reused automatically.
            </p>
            ${targets.map(([targetDbId, links]) => {
              const known = links[0]?.targetIsKnown;
              const targetRole = links[0]?.targetRole;
              return html`
                <div class="cnd-card">
                  <div class="cnd-card-head">
                    <strong>${links[0]?.targetTitle ?? "Untitled"}</strong>
                    <span class="cnd-mono">${targetDbId.slice(0, 8)}…</span>
                    ${known
                      ? targetRole
                        ? html`<span class="cnd-pill cnd-pill-ok">Resolved via ${ROLE_LABEL[targetRole as ChangeRoleId] ?? targetRole}</span>`
                        : html`<span class="cnd-pill cnd-pill-ok">Already known</span>`
                      : nothing}
                  </div>
                  <ul class="cnd-list">
                    ${links.map((l) => html`<li>via column <code>${l.sourceProp}</code></li>`)}
                  </ul>
                  ${!known
                    ? html`<label class="cnd-check">
                        <input
                          type="checkbox"
                          .checked=${opts.state.importRelatedByDb[targetDbId] !== false}
                          @change=${(e: Event) => {
                            opts.state.importRelatedByDb[targetDbId] = (e.target as HTMLInputElement).checked;
                            opts.requestUpdate();
                          }}
                        />
                        Also import this related database
                      </label>`
                    : nothing}
                </div>
              `;
            })}
          `}
    </div>
  `;
}

function renderCommit(opts: Actions): TemplateResult {
  const s = opts.state.commitSummary;
  return html`
    <div class="cnd-step">
      <h4>Done</h4>
      <p>
        Swapped <strong>${ROLE_LABEL[opts.state.role]}</strong> binding to the new database.
        ${s?.merged ? html` Linked <strong>${s.merged}</strong> overlapping row${s.merged === 1 ? "" : "s"}.` : nothing}
        ${s?.relatedImported ? html` Auto-imported <strong>${s.relatedImported}</strong> related database${s.relatedImported === 1 ? "" : "s"}.` : nothing}
      </p>
      <p class="cnd-muted">
        Field-by-field merges land in the conflict queue on the next sync — open the Conflicts tab to review.
      </p>
    </div>
  `;
}

function renderFooter(opts: Actions): TemplateResult {
  const step = opts.state.step;
  const back = (target: Step) => () => { opts.state.step = target; opts.requestUpdate(); };
  return html`
    <footer class="cnd-footer">
      <button class="cnd-btn" @click=${() => closeChangeNotionDbModal(opts)}>Cancel</button>
      <span class="cnd-spacer"></span>
      ${step === "discover"
        ? nothing
        : step === "mapping"
          ? html`
              <button class="cnd-btn" @click=${back("discover")}>← Back</button>
              <button class="cnd-btn cnd-btn-primary" ?disabled=${opts.state.busy} @click=${() => void goToOverlaps(opts)}>
                Next: scan overlaps →
              </button>
            `
          : step === "overlaps"
            ? html`
                <button class="cnd-btn" @click=${back("mapping")}>← Back</button>
                <button class="cnd-btn cnd-btn-primary" ?disabled=${opts.state.busy} @click=${() => void goToRelations(opts)}>
                  Next: relations →
                </button>
              `
            : step === "relations"
              ? html`
                  <button class="cnd-btn" @click=${back("overlaps")}>← Back</button>
                  <button class="cnd-btn cnd-btn-primary" ?disabled=${opts.state.busy} @click=${() => void commit(opts)}>
                    ${opts.state.busy ? "Committing…" : "Swap and merge"}
                  </button>
                `
              : html`<button class="cnd-btn cnd-btn-primary" @click=${() => closeChangeNotionDbModal(opts)}>Close</button>`}
    </footer>
  `;
}

export function renderChangeNotionDbModal(opts: Actions): TemplateResult {
  if (!opts.state.open) return html``;
  injectStyles();

  // Collapsed: render only a small floating dock so the operator can interact
  // with the underlying view without losing modal state. The dock survives
  // re-renders because it's bound to the same state object.
  if (opts.state.collapsed) {
    const stepLabel: Record<Step, string> = {
      discover: "Discover",
      mapping: "Mapping",
      overlaps: "Overlaps",
      relations: "Relations",
      commit: "Commit",
    };
    return html`
      <button
        class="cnd-dock"
        @click=${() => toggleCollapsed(opts)}
        title="Restore Change Notion DB"
        aria-label="Restore Change Notion DB modal"
      >
        <span class="cnd-dock-dot" aria-hidden="true"></span>
        <span class="cnd-dock-text">
          <span class="cnd-dock-title">Change Notion DB · ${ROLE_LABEL[opts.state.role]}</span>
          <span class="cnd-dock-step">${stepLabel[opts.state.step]}${opts.state.busy ? " · working…" : ""}</span>
        </span>
        <span class="cnd-dock-chev" aria-hidden="true">▴</span>
      </button>
    `;
  }

  return html`
    <div class="cnd-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) closeChangeNotionDbModal(opts); }}>
      <section class="cnd-modal" @click=${(e: Event) => e.stopPropagation()}>
        <header class="cnd-header">
          <strong>Change Notion DB — ${ROLE_LABEL[opts.state.role]}</strong>
          ${opts.state.currentNotionDbId
            ? html`<span class="cnd-mono">currently ${opts.state.currentNotionDbId.slice(0, 8)}…</span>`
            : html`<span class="cnd-muted">no current binding</span>`}
          <span class="cnd-spacer"></span>
          <button
            class="cnd-icon cnd-icon-min"
            @click=${() => toggleCollapsed(opts)}
            aria-label="Minimize"
            title="Minimize — keeps your progress, dock to bottom-right"
          >−</button>
          <button class="cnd-icon" @click=${() => closeChangeNotionDbModal(opts)} aria-label="Close">×</button>
        </header>
        ${opts.state.error ? html`<div class="cnd-error">${opts.state.error}</div>` : nothing}
        <main class="cnd-body">
          ${opts.state.step === "discover" ? renderDiscover(opts) : nothing}
          ${opts.state.step === "mapping" ? renderMapping(opts) : nothing}
          ${opts.state.step === "overlaps" ? renderOverlaps(opts) : nothing}
          ${opts.state.step === "relations" ? renderRelations(opts) : nothing}
          ${opts.state.step === "commit" ? renderCommit(opts) : nothing}
        </main>
        ${renderFooter(opts)}
      </section>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────
// Drop-in button helper — lets a parent view add a single line to its
// header to enable the swap flow without re-implementing state plumbing.
// ─────────────────────────────────────────────────────────────────────────

export function changeNotionDbButton(
  opts: Actions,
  role: ChangeRoleId,
  currentNotionDbId: string | null,
  label = "Change Notion DB",
): TemplateResult {
  return html`
    <button
      class="cnd-trigger"
      @click=${() => void openChangeNotionDbModal(opts, role, currentNotionDbId)}
      title="Swap which Notion database drives ${ROLE_LABEL[role]}"
    >
      ⇄ ${label}
    </button>
    ${renderChangeNotionDbModal(opts)}
  `;
}

// ─────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "infinibot-change-notion-db-modal-styles";
  style.textContent = CND_STYLES;
  document.head.appendChild(style);
}

const CND_STYLES = `
.cnd-trigger { font:inherit; cursor:pointer; padding:4px 10px; border-radius:6px; border:1px solid rgba(167,139,250,0.3); background:rgba(167,139,250,0.06); color:#c4b5fd; font-size:11px; }
.cnd-trigger:hover { background:rgba(167,139,250,0.12); border-color:rgba(167,139,250,0.5); }
.cnd-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.65); display:flex; align-items:center; justify-content:center; z-index:9999; padding:24px; }
.cnd-modal { background:#0d0d0f; border:1px solid rgba(250,204,21,0.16); border-radius:12px; max-width:880px; width:100%; max-height:85vh; display:flex; flex-direction:column; color:#f5f5f4; font-size:13px; box-shadow:0 24px 48px rgba(0,0,0,0.5); }
.cnd-header { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.06); }
.cnd-spacer { flex:1; }
.cnd-mono { font-family:ui-monospace,SFMono-Regular,monospace; font-size:11px; opacity:0.55; }
.cnd-muted { opacity:0.7; font-size:12px; }
.cnd-empty { padding:18px; text-align:center; opacity:0.55; border:1px dashed rgba(255,255,255,0.08); border-radius:6px; }
.cnd-error { color:#ef5b5b; font-size:12px; padding:6px 16px; background:rgba(239,91,91,0.08); }
.cnd-icon { background:none; border:none; color:#a3a3ad; font-size:20px; cursor:pointer; padding:0 4px; }
.cnd-icon:hover { color:#f5f5f4; }
.cnd-body { flex:1; overflow-y:auto; padding:14px 16px; }
.cnd-step h4 { margin:0 0 8px; font-size:14px; font-weight:600; }
.cnd-step p { margin:4px 0 12px; }
.cnd-table { width:100%; border-collapse:collapse; margin:8px 0; }
.cnd-table th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:#71717a; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.08); }
.cnd-table td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:12px; }
.cnd-current td { background:rgba(110,167,255,0.05); }
.cnd-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; margin-right:4px; background:rgba(255,255,255,0.06); color:#a3a3ad; }
.cnd-pill-ok { color:#5fd17a; background:rgba(95,209,122,0.08); }
.cnd-pill-warn { color:#f5b542; background:rgba(245,181,66,0.08); }
.cnd-pill-err { color:#ef5b5b; background:rgba(239,91,91,0.08); }
.cnd-pill-info { color:#6ea7ff; background:rgba(110,167,255,0.08); }
.cnd-link { color:#6ea7ff; text-decoration:none; font-size:11px; }
.cnd-select { padding:4px 8px; border:1px solid rgba(255,255,255,0.12); border-radius:4px; background:rgba(0,0,0,0.3); color:inherit; font:inherit; font-size:12px; }
.cnd-check { display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; margin:4px 0 8px; }
.cnd-card { padding:10px 12px; margin:8px 0; background:rgba(0,0,0,0.18); border-radius:8px; border:1px solid rgba(255,255,255,0.04); }
.cnd-card-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.cnd-list { margin:4px 0; padding-left:22px; font-size:12px; }
.cnd-list code { padding:1px 5px; border-radius:4px; background:rgba(255,255,255,0.06); font-size:11px; }
.cnd-footer { display:flex; align-items:center; gap:8px; padding:10px 16px; border-top:1px solid rgba(255,255,255,0.06); }
.cnd-btn { font:inherit; cursor:pointer; padding:6px 14px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:inherit; font-size:12px; }
.cnd-btn:disabled { opacity:0.5; cursor:progress; }
.cnd-btn:hover:not(:disabled) { background:rgba(255,255,255,0.1); }
.cnd-btn-primary { border-color:rgba(245,181,66,0.5); background:rgba(245,181,66,0.12); color:#ffc861; }
.cnd-btn-primary:hover:not(:disabled) { background:rgba(245,181,66,0.22); }

/* ── Loading skeleton (notion.import.listDatabases in flight) ── */
.cnd-skeleton { display:flex; flex-direction:column; gap:10px; padding:6px 0 4px; }
.cnd-skeleton-banner {
  display:flex; align-items:center; gap:10px;
  font-size:12px; color:#cbd5e1;
  padding:8px 12px;
  background:linear-gradient(90deg, rgba(167,139,250,0.06), rgba(110,167,255,0.06));
  border:1px solid rgba(167,139,250,0.18);
  border-radius:8px;
}
.cnd-skeleton-spinner {
  width:14px; height:14px; flex-shrink:0;
  border-radius:50%;
  border:2px solid rgba(167,139,250,0.18);
  border-top-color:#c4b5fd;
  animation: cnd-spin 0.85s linear infinite;
}
@keyframes cnd-spin { to { transform: rotate(360deg); } }

.cnd-skeleton-table tbody tr:hover { background: transparent; }
.cnd-skel {
  display:inline-block;
  border-radius:6px;
  background:
    linear-gradient(
      90deg,
      rgba(255,255,255,0.04) 0%,
      rgba(255,255,255,0.10) 50%,
      rgba(255,255,255,0.04) 100%
    );
  background-size:200% 100%;
  animation: cnd-shimmer 1.4s ease-in-out infinite;
}
.cnd-skel-btn  { width:54px; height:24px; }
.cnd-skel-bar  { height:12px; min-width:24px; }
.cnd-skel-pill { height:18px; border-radius:999px; }
@keyframes cnd-shimmer {
  0%   { background-position: 200% 0; opacity: 0.55; }
  50%  { opacity: 1; }
  100% { background-position: -200% 0; opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .cnd-skeleton-spinner { animation: none; border-top-color: rgba(196,181,253,0.6); }
  .cnd-skel { animation: none; opacity: 0.7; }
}

/* ── Minimize button + collapsed dock ─────────────────────────── */
.cnd-icon-min {
  font-size:18px; line-height:1;
  width:24px; height:24px;
  display:inline-flex; align-items:center; justify-content:center;
  border-radius:6px;
  margin-right:2px;
  padding-bottom:3px; /* visually align the en-dash with the × */
}
.cnd-icon-min:hover {
  background:rgba(255,255,255,0.06);
  color:#f5f5f4;
}

.cnd-dock {
  position:fixed; bottom:18px; right:18px; z-index:9998;
  display:inline-flex; align-items:center; gap:10px;
  padding:10px 14px;
  border-radius:14px;
  font:inherit; font-family:inherit; cursor:pointer;
  text-align:left;
  background:linear-gradient(135deg,
    color-mix(in srgb, #0d0d0f 70%, transparent),
    color-mix(in srgb, #0d0d0f 60%, transparent));
  border:1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent);
  color:#f5f5f4;
  backdrop-filter:blur(16px) saturate(140%);
  -webkit-backdrop-filter:blur(16px) saturate(140%);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.08) inset,
    0 12px 32px rgba(0,0,0,0.45),
    0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
  transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
  animation: cnd-dock-in 280ms ease;
}
.cnd-dock:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.12) inset,
    0 18px 42px rgba(0,0,0,0.55),
    0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
}
@keyframes cnd-dock-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.cnd-dock-dot {
  width:8px; height:8px; border-radius:50%;
  background: var(--g-primary, #fbbf24);
  box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary, #fbbf24) 70%, transparent);
  animation: cnd-dock-pulse 2s ease-in-out infinite;
  flex-shrink:0;
}
@keyframes cnd-dock-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.85); }
}

.cnd-dock-text { display:flex; flex-direction:column; line-height:1.25; }
.cnd-dock-title { font-size:12px; font-weight:600; }
.cnd-dock-step {
  font-size:10px;
  color:rgba(245,245,244,0.65);
  letter-spacing:0.05em;
}
.cnd-dock-chev {
  font-size:11px;
  color:rgba(245,245,244,0.55);
  margin-left:2px;
}
`;

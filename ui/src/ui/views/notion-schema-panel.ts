/**
 * <notion-schema-panel> — embeddable widget that surfaces the gateway's
 * notion.schema.* + notion.sync.pullNow RPCs to the operator.
 *
 * For each canonical role (projects / tasks / clients / leads / companies /
 * deals / contacts) it shows:
 *
 *   - Whether the Notion DB id is configured at all.
 *   - A schema-health badge (ok / X missing / Y type mismatches).
 *   - "Add missing properties" — calls notion.schema.applyPatch (additive).
 *   - "AI-suggest renames" — calls notion.schema.aiSuggest, then
 *     notion.schema.applyRename after operator approval.
 *
 * Plus a header strip with last-sync time and a "Pull from Notion now"
 * button (notion.sync.pullNow).
 *
 * Pure function, no own state file. Parent owns the state object and
 * passes it in; we mutate fields and call the parent's `requestUpdate`
 * helper to trigger a re-render.
 */
import { html, nothing, type TemplateResult } from "lit";
import { g8GlassStyles } from "./glass-g8.js";

import type { GatewayBrowserClient } from "../gateway";

export type SchemaRoleId = "projects" | "tasks" | "clients" | "leads" | "companies" | "deals" | "contacts";

const ROLE_ORDER: readonly SchemaRoleId[] = [
  "projects",
  "tasks",
  "clients",
  "leads",
  "companies",
  "deals",
  "contacts",
];

const ROLE_LABEL: Record<SchemaRoleId, string> = {
  projects: "Projects",
  tasks: "Tasks",
  clients: "Clients",
  leads: "Leads",
  companies: "Companies",
  deals: "Deals",
  contacts: "Contacts",
};

interface PropertyDiff {
  canonical: string;
  type: string;
  existingAlias: string | null;
  missing: boolean;
  typeMismatch: boolean;
  actualType: string | null;
}

interface SchemaDiff {
  dbId: string;
  role: string;
  titleProp: string | null;
  diffs: PropertyDiff[];
  satisfiesRequired: boolean;
}

interface AiSuggestion {
  mapping: Record<string, string>;
  rationale: string;
  existingProps: Array<{ name: string; type: string }>;
}

export interface NotionSchemaPanelState {
  /** notion.<role>DbId values from config.get — empty string if unset. */
  dbIds: Record<SchemaRoleId, string>;
  /** Latest diff per role (null until a check has run). */
  diffs: Partial<Record<SchemaRoleId, SchemaDiff>>;
  /** Latest AI suggestion per role. */
  suggestions: Partial<Record<SchemaRoleId, AiSuggestion>>;
  /** Per-role loading flags so spinners don't bleed across rows. */
  busyRoles: Set<SchemaRoleId>;
  /** Last successful pullNow: { ts: ms, projects: n, tasks: n }. null until first run. */
  lastPull: { ts: number; projects: number; tasks: number } | null;
  /** True while a pullNow request is in flight. */
  pulling: boolean;
  /** Surface error from a recent action; cleared on next successful action. */
  error: string | null;
}

export function createNotionSchemaPanelState(): NotionSchemaPanelState {
  return {
    dbIds: {
      projects: "",
      tasks: "",
      clients: "",
      leads: "",
      companies: "",
      deals: "",
      contacts: "",
    },
    diffs: {},
    suggestions: {},
    busyRoles: new Set(),
    lastPull: null,
    pulling: false,
    error: null,
  };
}

/**
 * Hydrate the panel's dbIds from a config snapshot. Call after fetching
 * `config.get` so the role rows render with the right Notion ids.
 */
export function applyConfigToSchemaPanelState(
  state: NotionSchemaPanelState,
  cfg: any,
): void {
  const notion = (cfg && typeof cfg === "object" && cfg.notion) || {};
  const map: Record<SchemaRoleId, string> = {
    projects: typeof notion.projectsDbId === "string" ? notion.projectsDbId : "",
    tasks: typeof notion.tasksDbId === "string" ? notion.tasksDbId : "",
    clients: typeof notion.clientsDbId === "string" ? notion.clientsDbId : "",
    leads: typeof notion.leadsDbId === "string" ? notion.leadsDbId : "",
    companies: typeof notion.companiesDbId === "string" ? notion.companiesDbId : "",
    deals: typeof notion.dealsDbId === "string" ? notion.dealsDbId : "",
    contacts: typeof notion.contactsDbId === "string" ? notion.contactsDbId : "",
  };
  state.dbIds = map;
}

// ─────────────────────────────────────────────────────────────────────────
// Actions — each mutates `state` and calls `requestUpdate` so the parent
// view re-renders. The parent passes a single `requestUpdate` callback so
// this widget never assumes a particular Lit / state-management library.
// ─────────────────────────────────────────────────────────────────────────

export interface NotionSchemaPanelActions {
  client: GatewayBrowserClient;
  state: NotionSchemaPanelState;
  requestUpdate: () => void;
}

async function rpc<T = unknown>(client: GatewayBrowserClient, method: string, params: unknown): Promise<T> {
  // Tolerate the three transport shapes the codebase uses (call / invoke /
  // request) so this widget works whether it's mounted in the Vite Control
  // UI or the gateway-served quickstart.
  const fn = (client as any)?.request || (client as any)?.call || (client as any)?.invoke;
  if (!fn) throw new Error("gateway client has no request/call/invoke method");
  return fn.call(client, method, params) as Promise<T>;
}

function setBusy(state: NotionSchemaPanelState, role: SchemaRoleId, busy: boolean): void {
  if (busy) state.busyRoles.add(role);
  else state.busyRoles.delete(role);
}

export async function runSchemaCheck(opts: NotionSchemaPanelActions, role: SchemaRoleId): Promise<void> {
  const dbId = opts.state.dbIds[role];
  if (!dbId) return;
  setBusy(opts.state, role, true);
  opts.state.error = null;
  opts.requestUpdate();
  try {
    const diff = await rpc<SchemaDiff>(opts.client, "notion.schema.diff", { dbId, role });
    opts.state.diffs[role] = diff;
  } catch (e: any) {
    opts.state.error = `Schema check failed for ${role}: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, role, false);
    opts.requestUpdate();
  }
}

export async function applySchemaPatch(opts: NotionSchemaPanelActions, role: SchemaRoleId): Promise<void> {
  const dbId = opts.state.dbIds[role];
  if (!dbId) return;
  setBusy(opts.state, role, true);
  opts.state.error = null;
  opts.requestUpdate();
  try {
    await rpc(opts.client, "notion.schema.applyPatch", { dbId, role });
    // Re-check so the UI reflects the post-patch shape.
    await runSchemaCheck(opts, role);
  } catch (e: any) {
    opts.state.error = `Apply patch failed for ${role}: ${e?.message ?? String(e)}`;
    setBusy(opts.state, role, false);
    opts.requestUpdate();
  }
}

export async function aiSuggestRenames(opts: NotionSchemaPanelActions, role: SchemaRoleId): Promise<void> {
  const dbId = opts.state.dbIds[role];
  if (!dbId) return;
  setBusy(opts.state, role, true);
  opts.state.error = null;
  opts.requestUpdate();
  try {
    const result = await rpc<AiSuggestion>(opts.client, "notion.schema.aiSuggest", { dbId, role });
    opts.state.suggestions[role] = result;
  } catch (e: any) {
    opts.state.error = `AI suggest failed for ${role}: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, role, false);
    opts.requestUpdate();
  }
}

export async function applySchemaRename(
  opts: NotionSchemaPanelActions,
  role: SchemaRoleId,
  mapping: Record<string, string>,
): Promise<void> {
  const dbId = opts.state.dbIds[role];
  if (!dbId) return;
  setBusy(opts.state, role, true);
  opts.state.error = null;
  opts.requestUpdate();
  try {
    await rpc(opts.client, "notion.schema.applyRename", { dbId, role, mapping });
    delete opts.state.suggestions[role];
    await runSchemaCheck(opts, role);
  } catch (e: any) {
    opts.state.error = `Apply rename failed for ${role}: ${e?.message ?? String(e)}`;
    setBusy(opts.state, role, false);
    opts.requestUpdate();
  }
}

export async function pullNow(opts: NotionSchemaPanelActions): Promise<void> {
  if (opts.state.pulling) return;
  opts.state.pulling = true;
  opts.state.error = null;
  opts.requestUpdate();
  try {
    const result = await rpc<{ projects: number; tasks: number; skipped: boolean }>(
      opts.client,
      "notion.sync.pullNow",
      {},
    );
    if (!result.skipped) {
      opts.state.lastPull = { ts: Date.now(), projects: result.projects, tasks: result.tasks };
    }
  } catch (e: any) {
    opts.state.error = `Sync now failed: ${e?.message ?? String(e)}`;
  } finally {
    opts.state.pulling = false;
    opts.requestUpdate();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────

function badgeForDiff(diff: SchemaDiff | undefined): TemplateResult {
  if (!diff) return html`<span class="nsp-badge nsp-badge-unknown">Not checked</span>`;
  const missing = diff.diffs.filter((d) => d.missing);
  const mismatch = diff.diffs.filter((d) => d.typeMismatch);
  if (missing.length === 0 && mismatch.length === 0) {
    return html`<span class="nsp-badge nsp-badge-ok">✓ Healthy</span>`;
  }
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.length} missing`);
  if (mismatch.length) parts.push(`${mismatch.length} type mismatch`);
  return html`<span class="nsp-badge nsp-badge-warn">! ${parts.join(", ")}</span>`;
}

function renderDiffDetails(role: SchemaRoleId, diff: SchemaDiff): TemplateResult {
  const missing = diff.diffs.filter((d) => d.missing);
  const mismatch = diff.diffs.filter((d) => d.typeMismatch);
  return html`
    <div class="nsp-detail">
      ${missing.length
        ? html`<div class="nsp-row"><strong>Missing:</strong> ${missing.map((d) => html`<code>${d.canonical}</code>`)}</div>`
        : nothing}
      ${mismatch.length
        ? html`<div class="nsp-row nsp-row-warn">
            <strong>Type mismatches (manual fix in Notion):</strong>
            ${mismatch.map((d) => html`<code>${d.canonical}</code> (${d.actualType ?? "?"}≠${d.type})`)}
          </div>`
        : nothing}
      ${diff.titleProp
        ? html`<div class="nsp-row nsp-row-muted">Title field: <code>${diff.titleProp}</code></div>`
        : nothing}
    </div>
  `;
}

function renderSuggestion(
  opts: NotionSchemaPanelActions,
  role: SchemaRoleId,
  sugg: AiSuggestion,
): TemplateResult {
  const entries = Object.entries(sugg.mapping);
  if (entries.length === 0) {
    return html`<div class="nsp-suggestion nsp-row-muted">AI found no rename candidates.</div>`;
  }
  return html`
    <div class="nsp-suggestion">
      <strong>AI-suggested renames:</strong>
      ${sugg.rationale ? html`<p class="nsp-row-muted">${sugg.rationale}</p>` : nothing}
      <ul>
        ${entries.map(([from, to]) => html`<li><code>${from}</code> → <code>${to}</code></li>`)}
      </ul>
      <div class="nsp-actions">
        <button
          class="nsp-btn nsp-btn-primary"
          ?disabled=${opts.state.busyRoles.has(role)}
          @click=${() => void applySchemaRename(opts, role, sugg.mapping)}
        >
          Apply renames
        </button>
        <button
          class="nsp-btn"
          ?disabled=${opts.state.busyRoles.has(role)}
          @click=${() => {
            delete opts.state.suggestions[role];
            opts.requestUpdate();
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  `;
}

function renderRoleRow(opts: NotionSchemaPanelActions, role: SchemaRoleId): TemplateResult {
  const dbId = opts.state.dbIds[role];
  const diff = opts.state.diffs[role];
  const suggestion = opts.state.suggestions[role];
  const busy = opts.state.busyRoles.has(role);

  if (!dbId) {
    return html`
      <div class="nsp-rowwrap nsp-rowwrap-disabled">
        <div class="nsp-head">
          <span class="nsp-name">${ROLE_LABEL[role]}</span>
          <span class="nsp-badge nsp-badge-unknown">Not configured</span>
        </div>
      </div>
    `;
  }

  const missing = diff?.diffs.filter((d) => d.missing) ?? [];
  const canPatch = missing.length > 0 && missing.some((d) => d.type !== "title" && d.type !== "relation");

  return html`
    <div class="nsp-rowwrap">
      <div class="nsp-head">
        <span class="nsp-name">${ROLE_LABEL[role]}</span>
        ${badgeForDiff(diff)}
        <code class="nsp-dbid">${dbId.slice(0, 8)}…</code>
        <div class="nsp-spacer"></div>
        <button class="nsp-btn" ?disabled=${busy} @click=${() => void runSchemaCheck(opts, role)}>
          ${busy && !diff ? "Checking…" : "Check schema"}
        </button>
        ${canPatch
          ? html`<button
              class="nsp-btn nsp-btn-primary"
              ?disabled=${busy}
              @click=${() => void applySchemaPatch(opts, role)}
            >
              Add missing
            </button>`
          : nothing}
        <button class="nsp-btn" ?disabled=${busy} @click=${() => void aiSuggestRenames(opts, role)}>
          AI rename
        </button>
      </div>
      ${diff ? renderDiffDetails(role, diff) : nothing}
      ${suggestion ? renderSuggestion(opts, role, suggestion) : nothing}
    </div>
  `;
}

export function renderNotionSchemaPanel(opts: NotionSchemaPanelActions): TemplateResult {
  injectStyles();
  const lp = opts.state.lastPull;
  const lpText = lp
    ? `Last pull: ${new Date(lp.ts).toLocaleTimeString()} — ${lp.projects} projects, ${lp.tasks} tasks`
    : "Last pull: pending";

  return html`
    ${g8GlassStyles}
    <section class="nsp g8-page">
      <header class="nsp-head-strip">
        <span class="nsp-title">Notion sync &amp; schema</span>
        <div class="nsp-spacer"></div>
        <span class="nsp-row-muted">${lpText}</span>
        <button
          class="nsp-btn"
          ?disabled=${opts.state.pulling}
          @click=${() => void pullNow(opts)}
        >
          ${opts.state.pulling ? "Syncing…" : "Pull from Notion now"}
        </button>
      </header>
      ${opts.state.error
        ? html`<div class="nsp-error">${opts.state.error}</div>`
        : nothing}
      <div class="nsp-rows">
        ${ROLE_ORDER.map((role) => renderRoleRow(opts, role))}
      </div>
    </section>
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
  style.id = "infinibot-notion-schema-panel-styles";
  style.textContent = NSP_STYLES;
  document.head.appendChild(style);
}

const NSP_STYLES = `
.nsp {
  border: 1px solid rgba(250, 204, 21, 0.16);
  background: linear-gradient(180deg, rgba(250, 204, 21, 0.04), rgba(0, 0, 0, 0.18));
  border-radius: 12px;
  padding: 12px 14px;
  color: var(--c-fg, #f5f5f4);
  font-size: 13px;
}
.nsp-head-strip { display: flex; align-items: center; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 8px; }
.nsp-title { font-weight: 600; font-size: 14px; }
.nsp-spacer { flex: 1; }
.nsp-rows { display: flex; flex-direction: column; gap: 6px; }
.nsp-rowwrap { padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.18); }
.nsp-rowwrap-disabled { opacity: 0.55; }
.nsp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nsp-name { font-weight: 500; min-width: 90px; }
.nsp-dbid { font-size: 11px; opacity: 0.55; font-family: ui-monospace, SFMono-Regular, monospace; }
.nsp-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; }
.nsp-badge-ok { color: #5fd17a; border-color: rgba(95, 209, 122, 0.4); background: rgba(95, 209, 122, 0.08); }
.nsp-badge-warn { color: #f5b542; border-color: rgba(245, 181, 66, 0.4); background: rgba(245, 181, 66, 0.08); }
.nsp-badge-unknown { color: #a3a3ad; border-color: rgba(163, 163, 173, 0.3); background: rgba(163, 163, 173, 0.05); }
.nsp-btn {
  font: inherit; cursor: pointer;
  padding: 4px 10px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.04);
  color: inherit;
}
.nsp-btn:disabled { opacity: 0.5; cursor: progress; }
.nsp-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
.nsp-btn-primary {
  border-color: rgba(245, 181, 66, 0.5);
  background: rgba(245, 181, 66, 0.12);
  color: #ffc861;
}
.nsp-btn-primary:hover:not(:disabled) { background: rgba(245, 181, 66, 0.22); }
.nsp-detail { margin-top: 6px; padding: 6px 8px; background: rgba(0,0,0,0.25); border-radius: 6px; }
.nsp-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 2px 0; }
.nsp-row-warn { color: #f5b542; }
.nsp-row-muted { opacity: 0.7; font-size: 12px; }
.nsp-row code { padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.06); font-size: 12px; }
.nsp-suggestion { margin-top: 6px; padding: 8px 10px; border: 1px solid rgba(245, 181, 66, 0.3); border-radius: 6px; background: rgba(245, 181, 66, 0.04); }
.nsp-suggestion ul { margin: 4px 0 8px; padding-left: 22px; }
.nsp-suggestion code { padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,0.25); font-size: 12px; }
.nsp-actions { display: flex; gap: 6px; }
.nsp-error { color: #ef5b5b; font-size: 12px; padding: 4px 0; }
`;

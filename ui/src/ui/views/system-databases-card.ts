/**
 * Shared <system-databases-card> UI — dropdowns to assign each well-known
 * role (Projects / Tasks / Notes / Clients / Leads) to an existing database.
 *
 * Rendered in two places, bound to the SAME DatabasesState so changes in
 * either surface sync automatically on the next render:
 *
 *   • Databases view sidebar (compact mode — stacked layout).
 *   • Config tab (full mode — horizontal layout with descriptions).
 *
 * The component is a plain function (no custom element). Keep it side-effect
 * free: reads from state, dispatches handlers from the controller.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { icons } from "../icons.js";
import {
  SYSTEM_ROLES,
  SYSTEM_ROLE_LABELS,
  type DatabaseRecord,
  type DatabasesState,
  type SystemRole,
  clearSystemRole,
  getDatabasesState,
  rolesForDatabase,
  setSystemRole,
} from "../controllers/databases.js";

const ROLE_HELP: Record<SystemRole, string> = {
  projects: "Master projects database. Kanban and agents read projects from here.",
  tasks: "Master tasks database. Kanban tasks and agent task tooling default here.",
  notes: "Note-taking surface for agents and the notes panel.",
  clients: "CRM contacts. Business workflows attach conversations and deals here.",
  leads: "Funnel pipeline. Lead capture + qualification surface.",
};

const ROLE_ICONS: Record<SystemRole, TemplateResult> = {
  projects: icons.folder,
  tasks: icons.checkCircle,
  notes: icons.fileText,
  clients: icons.users,
  leads: icons.target,
};

export interface SystemDatabasesCardOpts {
  /** "compact" = sidebar (stacked rows); "full" = config tab (horizontal + help). */
  mode: "compact" | "full";
}

/**
 * Per-(mode) collapsed flag. Compact (the /databases sidebar) defaults to
 * collapsed because the card is competing with the database list for
 * vertical real estate; full mode (the Config tab) defaults to expanded
 * because that's the context where the user came specifically to manage
 * system roles.
 *
 * Module-level instead of on DatabasesState because the card is rendered
 * as a function in two parallel surfaces — keeping the flag here means
 * either surface can flip it without thinking about state plumbing.
 */
let collapsedByMode: { compact: boolean; full: boolean } = {
  compact: true,
  full: false,
};

function toggleCollapsed(state: AppViewState, mode: "compact" | "full"): void {
  collapsedByMode = { ...collapsedByMode, [mode]: !collapsedByMode[mode] };
  state.requestUpdate?.();
}

export function renderSystemDatabasesCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: SystemDatabasesCardOpts = { mode: "full" },
) {
  injectStyles();
  const s = getDatabasesState(state);
  const compact = opts.mode === "compact";
  const collapsed = collapsedByMode[opts.mode];
  // Show how many roles are mapped vs. total in the collapsed header so
  // the user has a quick "is this set up?" cue before expanding.
  const totalRoles = SYSTEM_ROLES.length;
  const mappedCount = SYSTEM_ROLES.filter((r) => Boolean(s.systemRoles[r])).length;

  return html`
    <section class="sdc ${compact ? "sdc-compact" : "sdc-full"} ${collapsed ? "sdc-collapsed" : ""}">
      <button
        class="sdc-head sdc-head-toggle"
        type="button"
        @click=${() => toggleCollapsed(state, opts.mode)}
        aria-expanded=${collapsed ? "false" : "true"}
        title=${collapsed ? "Show system database assignments" : "Hide system database assignments"}
      >
        <span class="sdc-icon">${icons.settings}</span>
        <span class="sdc-title">${compact ? "System" : "System Databases"}</span>
        <span class="sdc-count">${mappedCount}/${totalRoles}</span>
        ${compact || collapsed ? nothing : html`
          <span class="sdc-sub">
            Pick which database backs each role. Agent tools, kanban, and the notes
            panel read through these assignments instead of hardcoded ids.
          </span>
        `}
        <span class="sdc-chev" aria-hidden="true">${collapsed ? "▾" : "▴"}</span>
      </button>

      ${collapsed ? nothing : html`
        <div class="sdc-rows">
          ${SYSTEM_ROLES.map((role) => renderRoleRow(role, s, state, client, compact))}
        </div>
      `}
    </section>
  `;
}

function renderRoleRow(
  role: SystemRole,
  s: DatabasesState,
  state: AppViewState,
  client: GatewayBrowserClient,
  compact: boolean,
) {
  const currentId = s.systemRoles[role];
  const db = currentId ? s.databases.find((d) => d.id === currentId) : null;

  // When a role is bound, surface the actual database name (which for kanban
  // sources tracks the bound Notion DB title) as the primary label and demote
  // the role label to a sub-line. This makes "what's actually backing this
  // role right now" immediately visible — e.g. "2026 Roadmap" with "Projects"
  // underneath, instead of the generic "Projects" hiding which DB it points
  // to until you open the dropdown.
  const primaryName = db?.name ?? SYSTEM_ROLE_LABELS[role];
  const subline = db ? SYSTEM_ROLE_LABELS[role] : null;

  return html`
    <div class="sdc-row ${currentId ? "has-assign" : "no-assign"}">
      <div class="sdc-role">
        <span class="sdc-role-icon">${ROLE_ICONS[role]}</span>
        <div class="sdc-role-labels">
          <span class="sdc-role-name" title=${db ? `Role: ${SYSTEM_ROLE_LABELS[role]}` : ""}>${primaryName}</span>
          ${subline ? html`<span class="sdc-role-binding">${subline}</span>` : nothing}
          ${compact ? nothing : html`
            <span class="sdc-role-help">${ROLE_HELP[role]}</span>
          `}
        </div>
      </div>

      <div class="sdc-picker">
        <div class="sdc-select-wrap">
          <select
            class="sdc-select"
            @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              if (!val) {
                void clearSystemRole(state, client, role);
              } else {
                void setSystemRole(state, client, role, val);
              }
            }}
          >
            <option value="" ?selected=${!currentId}>— not assigned —</option>
            ${s.databases.map((d) => html`
              <option value=${d.id} ?selected=${currentId === d.id}>
                ${d.icon ? d.icon + " " : ""}${d.name}${d.source.startsWith("kanban") ? " · kanban" : d.source === "notion-import" ? " · notion" : ""}
              </option>
            `)}
            ${currentId && !s.databases.some((d) => d.id === currentId) ? html`
              <option value=${currentId} ?selected=${true}>— missing database —</option>
            ` : nothing}
          </select>
          <span class="sdc-select-chevron">${icons.chevronDown}</span>
        </div>

        ${db ? html`
          <button
            class="sdc-clear"
            title="Unassign"
            @click=${() => void clearSystemRole(state, client, role)}
          >${icons.x}</button>
        ` : nothing}
      </div>
    </div>
  `;
}

/**
 * Little icon chips next to a database name when it's serving one or more
 * system roles. Call from the databases sidebar list.
 */
export function renderSystemRoleBadges(s: DatabasesState, databaseId: string) {
  const roles = rolesForDatabase(s, databaseId);
  if (!roles.length) return nothing;
  return html`
    <span class="sdc-badges">
      ${roles.map((r) => html`
        <span class="sdc-badge" title=${`System ${SYSTEM_ROLE_LABELS[r]}`}>
          ${ROLE_ICONS[r]}
        </span>
      `)}
    </span>
  `;
}

/** CSS class helpers for the sidebar "this is a system-role database" ring. */
export function systemDatabaseHighlightClass(s: DatabasesState, databaseId: string): string {
  return rolesForDatabase(s, databaseId).length > 0 ? "sdc-system-db" : "";
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "moltbot-sdc-styles";
  style.textContent = SDC_STYLES;
  document.head.appendChild(style);
}

const SDC_STYLES = `
.sdc {
  border: 1px solid rgba(250, 204, 21, 0.16);
  background:
    linear-gradient(180deg, rgba(250, 204, 21, 0.05), rgba(0, 0, 0, 0.2));
  border-radius: 12px;
  padding: 12px;
  backdrop-filter: blur(14px);
  color: var(--c-fg, #f5f5f4);
}

.sdc-compact { padding: 10px; }

.sdc svg {
  width: 1em;
  height: 1em;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vertical-align: middle;
}

.sdc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
/* Toggle variant — looks like a button when collapsable */
button.sdc-head-toggle {
  appearance: none;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 8px;
  width: 100%;
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
  transition: background 160ms ease, border-color 160ms ease;
}
button.sdc-head-toggle:hover {
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 6%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
}
.sdc-collapsed button.sdc-head-toggle { margin-bottom: 0; }
.sdc-count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
  color: color-mix(in srgb, var(--g-primary, #fbbf24) 90%, #cbd5e1);
  border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent);
}
.sdc-chev {
  margin-left: auto;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  transition: transform 180ms ease;
}
button.sdc-head-toggle:hover .sdc-chev {
  color: var(--g-primary, #fbbf24);
}
.sdc-icon { font-size: 14px; color: var(--c-accent, var(--g-primary, #fbbf24)); display: inline-flex; }
.sdc-title {
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--c-accent, var(--g-primary, #fbbf24));
}
.sdc-sub {
  flex: 1 1 100%;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.4;
}

.sdc-rows { display: flex; flex-direction: column; gap: 6px; }

/* FULL mode — horizontal layout with room for help text */
.sdc-full .sdc-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(200px, 280px);
  gap: 14px;
  align-items: center;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  transition: border-color 0.15s, background 0.15s;
}

/* COMPACT mode — stacked rows, picker full-width */
.sdc-compact .sdc-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  transition: border-color 0.15s, background 0.15s;
}

@media (max-width: 560px) {
  .sdc-full .sdc-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}

.sdc-row.has-assign {
  background: rgba(250, 204, 21, 0.05);
  border-color: rgba(250, 204, 21, 0.16);
}

.sdc-role {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sdc-role-icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: var(--c-accent, var(--g-primary, #fbbf24));
}
.sdc-role-labels {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sdc-role-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sdc-role-help {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
  line-height: 1.45;
}
.sdc-role-binding {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--g-primary, #fbbf24) 75%, rgba(255,255,255,0.55));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sdc-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sdc-compact .sdc-picker { width: 100%; }

.sdc-select-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.sdc-select {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  width: 100%;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(0, 0, 0, 0.4));
  border: 1px solid rgba(250, 204, 21, 0.18);
  border-radius: 8px;
  color: var(--c-fg, #f5f5f4);
  padding: 6px 28px 6px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}
.sdc-select:hover {
  border-color: rgba(250, 204, 21, 0.32);
  background:
    linear-gradient(180deg, rgba(250, 204, 21, 0.06), rgba(0, 0, 0, 0.4));
}
.sdc-select:focus {
  border-color: var(--c-accent, var(--g-primary, #fbbf24));
  box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.12);
}
.sdc-select option {
  background: #0b0b10;
  color: var(--c-fg, #f5f5f4);
}

.sdc-select-chevron {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  width: 14px;
  height: 14px;
  color: rgba(255, 255, 255, 0.6);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sdc-clear {
  flex: 0 0 auto;
  appearance: none;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.6);
  width: 26px;
  height: 26px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.sdc-clear svg { width: 14px; height: 14px; }
.sdc-clear:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
}

/* Sidebar badges — mini icons of whichever roles this database fills */
.sdc-badges {
  display: inline-flex;
  gap: 3px;
  margin-left: 6px;
}
.sdc-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 2px;
  background: rgba(250, 204, 21, 0.12);
  border: 1px solid rgba(250, 204, 21, 0.28);
  border-radius: 5px;
  color: var(--c-accent, var(--g-primary, #fbbf24));
}
.sdc-badge svg { width: 12px; height: 12px; }

/* Highlight class applied to the sidebar list item for system databases */
.sdc-system-db {
  background: linear-gradient(90deg, rgba(250, 204, 21, 0.1), transparent) !important;
  border-left: 2px solid var(--c-accent, var(--g-primary, #fbbf24));
}
`;

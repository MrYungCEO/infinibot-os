/**
 * Universal Notion Database Manager View — Grid/Table/Kanban views for any Notion database.
 */

import { html, nothing } from "lit";
import { g8GlassStyles } from "./glass-g8.js";
import "../components/doc-agent-panel";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type {
  NotionDbManagerState,
  NotionDatabaseEntry,
  NotionPage,
  NotionDbSchema,
  NotionPropertySchema,
  NotionBlock,
} from "../controllers/notion-databases";
import {
  getFilteredPages,
  getPagesByGroup,
  getGroupableProperties,
  getGroupOptions,
  getDefaultGroupBy,
  getTitleProperty,
  getPageTitle,
  loadDatabases,
  selectDatabase,
  addDatabase,
  addDatabaseById,
  removeDatabase,
  refreshDatabase,
  pullPages,
  createPage,
  updatePage,
  updatePageProperty,
  deletePage,
  discoverDatabases,
  loadPageBlocks,
  navigateToSubPage,
  navigateBack,
  resolveRelations,
  toggleBlock,
} from "../controllers/notion-databases";
import {
  applyConfigToSchemaPanelState,
  createNotionSchemaPanelState,
  renderNotionSchemaPanel,
  type NotionSchemaPanelState,
} from "./notion-schema-panel";
import {
  createNotionImportWizardState,
  renderNotionImportWizard,
  type NotionImportWizardState,
} from "./notion-import-wizard";
import {
  createNotionConflictsPanelState,
  loadConflicts,
  renderNotionConflictsPanel,
  type NotionConflictsPanelState,
} from "./notion-conflicts-panel";

// ── Helpers ──────────────────────────────────────────────────

function hashColor(str: string): string {
  if (!str) str = "?";
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = str.charCodeAt(i) + ((hash << 5) - hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function initials(name: string): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function notionColor(color: string): string {
  const map: Record<string, string> = {
    default: "#6b7280", gray: "#6b7280", brown: "#92400e", orange: "#ea580c",
    yellow: "#eab308", green: "#22c55e", blue: "#3b82f6", purple: "#a855f7",
    pink: "#ec4899", red: "#ef4444",
  };
  return map[color] ?? map.default;
}

function notionBg(color: string): string {
  const map: Record<string, string> = {
    default: "rgba(107,114,128,0.1)", gray: "rgba(107,114,128,0.1)", brown: "rgba(146,64,14,0.1)",
    orange: "rgba(234,88,12,0.1)", yellow: "rgba(234,179,8,0.1)", green: "rgba(34,197,94,0.1)",
    blue: "rgba(59,130,246,0.1)", purple: "rgba(168,85,247,0.1)", pink: "rgba(236,72,153,0.1)",
    red: "rgba(239,68,68,0.1)",
  };
  return map[color] ?? map.default;
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function getFirstValue(page: NotionPage, schema: NotionDbSchema | null, type: string): any {
  if (!schema || !page?.data) return null;
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === type && page.data[name] != null && page.data[name] !== "") {
      return { name, value: page.data[name], prop };
    }
  }
  return null;
}

function getOptionColor(schema: NotionDbSchema | null, propName: string, value: string): string {
  if (!schema) return "default";
  const prop = schema.properties[propName];
  const opt = prop?.options?.find((o) => o.name === value);
  return opt?.color ?? "default";
}

// ── Styles ───────────────────────────────────────────────────

const ndbStyles = html`
<style>
  .ndb-page { display:flex; flex-direction:column; height:100%; overflow:hidden; font-family:'JetBrains Mono','Fira Code','SF Mono',monospace; color:#e4e4e7; background:transparent; }
  .ndb-layout { display:flex; flex:1; overflow:hidden; min-height:0; }
  .ndb-sidebar { width:220px; flex-shrink:0; border-right:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); background:#050505; display:flex; flex-direction:column; overflow:hidden; }
  .ndb-sidebar-header { padding:10px 12px; font-size:9px; text-transform:uppercase; letter-spacing:0.15em; color:var(--g-primary); font-weight:700; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); display:flex; align-items:center; justify-content:space-between; }
  .ndb-sidebar-list { flex:1; overflow-y:auto; padding:6px; }
  .ndb-sidebar-list::-webkit-scrollbar { width:3px; }
  .ndb-sidebar-list::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--g-primary) 10%, transparent); }
  .ndb-sidebar-item { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; transition:all 0.15s; border:1px solid transparent; margin-bottom:2px; }
  .ndb-sidebar-item:hover { background:color-mix(in srgb, var(--g-primary) 3%, transparent); border-color:color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .ndb-sidebar-item.active { background:color-mix(in srgb, var(--g-primary) 6%, transparent); border-color:color-mix(in srgb, var(--g-primary) 15%, transparent); }
  .ndb-sidebar-icon { font-size:16px; flex-shrink:0; }
  .ndb-sidebar-info { flex:1; min-width:0; }
  .ndb-sidebar-name { font-size:11px; font-weight:600; color:#e4e4e7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ndb-sidebar-meta { font-size:8px; color:#52525b; margin-top:1px; }
  .ndb-sidebar-actions { display:flex; gap:2px; opacity:0; transition:opacity 0.15s; }
  .ndb-sidebar-item:hover .ndb-sidebar-actions { opacity:1; }
  .ndb-sidebar-action { padding:1px 4px; font-family:inherit; font-size:9px; border:none; background:transparent; color:#52525b; cursor:pointer; }
  .ndb-sidebar-action:hover { color:var(--g-primary); }
  .ndb-sidebar-action.danger:hover { color:#f87171; }
  .ndb-sidebar-add { display:flex; align-items:center; gap:6px; padding:8px 10px; margin:4px 6px; cursor:pointer; border:1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent); transition:all 0.15s; color:var(--g-primary); font-size:9px; text-transform:uppercase; letter-spacing:0.1em; }
  .ndb-sidebar-add:hover { border-color:color-mix(in srgb, var(--g-primary) 30%, transparent); background:color-mix(in srgb, var(--g-primary) 3%, transparent); }

  .ndb-main-area { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
  .ndb-topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 16px; background:#080808; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); flex-shrink:0; flex-wrap:wrap; }
  .ndb-topbar-left { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .ndb-topbar-right { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .ndb-badge { font-size:9px; text-transform:uppercase; letter-spacing:0.15em; padding:3px 8px; border:1px solid color-mix(in srgb, var(--g-primary) 15%, transparent); color:var(--g-primary); background:color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .ndb-count { font-size:9px; color:#52525b; }
  .ndb-view-toggle { display:flex; border:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); overflow:hidden; }
  .ndb-view-btn { padding:3px 10px; font-family:inherit; font-size:9px; letter-spacing:0.05em; border:none; background:transparent; color:#52525b; cursor:pointer; transition:all 0.12s; border-right:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .ndb-view-btn:last-child { border-right:none; }
  .ndb-view-btn:hover { color:#a1a1aa; }
  .ndb-view-btn.active { color:var(--g-primary); background:color-mix(in srgb, var(--g-primary) 10%, transparent); }
  .ndb-search { padding:4px 10px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); color:#e4e4e7; font-family:inherit; font-size:10px; outline:none; width:180px; transition:border-color 0.15s; }
  .ndb-search:focus { border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); box-shadow:0 0 8px color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .ndb-search::placeholder { color:#3f3f46; }
  .ndb-select { padding:4px 8px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); color:#a1a1aa; font-family:inherit; font-size:9px; outline:none; cursor:pointer; appearance:none; -webkit-appearance:none; }
  .ndb-select:focus { border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); }
  .ndb-select option { background:#0a0a0a; color:#e4e4e7; }
  .ndb-btn { padding:4px 12px; font-family:inherit; font-size:10px; text-transform:uppercase; letter-spacing:0.1em; border:1px solid color-mix(in srgb, var(--g-primary) 15%, transparent); background:color-mix(in srgb, var(--g-primary) 4%, transparent); color:var(--g-primary); cursor:pointer; transition:all 0.15s; }
  .ndb-btn:hover:not(:disabled) { background:color-mix(in srgb, var(--g-primary) 10%, transparent); border-color:color-mix(in srgb, var(--g-primary) 35%, transparent); color:var(--g-primary); box-shadow:0 0 8px color-mix(in srgb, var(--g-primary) 8%, transparent); }
  .ndb-btn:disabled { opacity:0.35; cursor:not-allowed; }
  .ndb-btn.primary { background:color-mix(in srgb, var(--g-primary) 12%, transparent); border-color:color-mix(in srgb, var(--g-primary) 30%, transparent); color:var(--g-primary); }
  .ndb-btn.danger { border-color:rgba(239,68,68,0.3); color:#f87171; background:rgba(239,68,68,0.04); }
  .ndb-btn.danger:hover:not(:disabled) { background:rgba(239,68,68,0.1); border-color:rgba(239,68,68,0.5); }
  .ndb-btn-sm { padding:2px 8px; font-size:9px; }
  .ndb-btn-notion { border-color:rgba(167,139,250,0.2); color:#a78bfa; background:rgba(167,139,250,0.04); }
  .ndb-btn-notion:hover:not(:disabled) { background:rgba(167,139,250,0.1); border-color:rgba(167,139,250,0.4); color:#c4b5fd; }
  .ndb-success { padding:6px 12px; background:rgba(34,197,94,0.06); border:1px solid rgba(34,197,94,0.15); color:#4ade80; font-size:11px; flex-shrink:0; }
  .ndb-error { padding:6px 12px; background:rgba(220,38,38,0.06); border:1px solid rgba(220,38,38,0.15); color:#f87171; font-size:11px; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
  .ndb-error-dismiss { background:none; border:none; color:#f87171; cursor:pointer; font-size:12px; padding:0 4px; }

  .ndb-notion-bar { display:flex; align-items:center; gap:8px; padding:6px 16px; background:#050505; border-bottom:1px solid rgba(167,139,250,0.06); flex-shrink:0; font-size:9px; color:#71717a; flex-wrap:wrap; }
  .ndb-notion-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
  .ndb-notion-dot.connected { background:#a78bfa; box-shadow:0 0 6px rgba(167,139,250,0.5); }
  .ndb-notion-dot.disconnected { background:#3f3f46; }

  .ndb-content { flex:1; display:flex; overflow:hidden; min-height:0; }
  .ndb-main { flex:1; overflow-y:auto; padding:16px; min-height:0; }
  .ndb-main::-webkit-scrollbar { width:4px; }
  .ndb-main::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--g-primary) 12%, transparent); }

  /* Grid */
  .ndb-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; }
  .ndb-card { background:#080808; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); padding:14px 16px; cursor:pointer; transition:all 0.2s; position:relative; }
  .ndb-card:hover { border-color:color-mix(in srgb, var(--g-primary) 20%, transparent); box-shadow:0 0 20px color-mix(in srgb, var(--g-primary) 4%, transparent); background:#0a0a0a; }
  .ndb-card.selected { border-color:color-mix(in srgb, var(--g-primary) 35%, transparent); background:#0c0c0c; }
  .ndb-card-header { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .ndb-avatar { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; flex-shrink:0; letter-spacing:0.05em; }
  .ndb-card-info { flex:1; min-width:0; }
  .ndb-card-name { font-size:12px; font-weight:700; color:#e4e4e7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ndb-card-sub { font-size:9px; color:#71717a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:1px; }
  .ndb-card-details { display:flex; flex-direction:column; gap:4px; margin-bottom:8px; }
  .ndb-card-detail { display:flex; align-items:center; gap:6px; font-size:9px; color:#71717a; }
  .ndb-card-footer { display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap; }
  .ndb-status-badge { display:inline-flex; align-items:center; gap:4px; font-size:8px; text-transform:uppercase; letter-spacing:0.1em; padding:2px 6px; font-weight:600; }
  .ndb-tags { display:flex; gap:3px; flex-wrap:wrap; }
  .ndb-tag { font-size:8px; padding:1px 5px; background:color-mix(in srgb, var(--g-primary) 6%, transparent); border:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); color:var(--g-primary); }
  .ndb-card-time { font-size:8px; color:#3f3f46; }
  .ndb-card-actions { position:absolute; top:8px; right:8px; display:flex; gap:3px; opacity:0; transition:opacity 0.15s; }
  .ndb-card:hover .ndb-card-actions { opacity:1; }
  .ndb-card-action { padding:2px 6px; font-family:inherit; font-size:9px; border:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); background:rgba(0,0,0,0.5); color:#a1a1aa; cursor:pointer; transition:all 0.12s; backdrop-filter:blur(4px); }
  .ndb-card-action:hover { color:var(--g-primary); border-color:color-mix(in srgb, var(--g-primary) 30%, transparent); }
  .ndb-card-action.danger:hover { color:#f87171; border-color:rgba(239,68,68,0.3); }

  /* Table */
  .ndb-table-wrap { overflow-x:auto; }
  .ndb-table { width:100%; border-collapse:collapse; font-size:10px; }
  .ndb-table th { text-align:left; font-size:8px; text-transform:uppercase; letter-spacing:0.15em; color:#71717a; padding:6px 10px; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); cursor:pointer; user-select:none; white-space:nowrap; }
  .ndb-table th:hover { color:var(--g-primary); }
  .ndb-table th.sorted { color:var(--g-primary); }
  .ndb-table td { padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.02); color:#a1a1aa; vertical-align:middle; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ndb-table tr { transition:background 0.12s; cursor:pointer; }
  .ndb-table tbody tr:hover { background:color-mix(in srgb, var(--g-primary) 2%, transparent); }
  .ndb-table-name { display:flex; align-items:center; gap:8px; }
  .ndb-table-avatar { width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; color:#fff; flex-shrink:0; }
  .ndb-table-name-text { color:#e4e4e7; font-weight:600; }

  /* Kanban */
  .ndb-kanban { display:flex; gap:12px; overflow-x:auto; min-height:0; height:100%; padding-bottom:8px; }
  .ndb-kanban::-webkit-scrollbar { height:4px; }
  .ndb-kanban::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--g-primary) 12%, transparent); }
  .ndb-kanban-col { flex:0 0 260px; display:flex; flex-direction:column; background:#060606; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); overflow:hidden; }
  .ndb-kanban-header { padding:8px 12px; font-size:9px; text-transform:uppercase; letter-spacing:0.15em; font-weight:700; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); display:flex; align-items:center; justify-content:space-between; }
  .ndb-kanban-count { font-size:8px; font-weight:400; color:#52525b; padding:1px 5px; background:rgba(255,255,255,0.03); }
  .ndb-kanban-cards { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
  .ndb-kanban-cards::-webkit-scrollbar { width:3px; }
  .ndb-kanban-cards::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--g-primary) 8%, transparent); }
  .ndb-kanban-card { padding:10px 12px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 4%, transparent); cursor:pointer; transition:all 0.15s; }
  .ndb-kanban-card:hover { border-color:color-mix(in srgb, var(--g-primary) 15%, transparent); background:#0c0c0c; }
  .ndb-kanban-card-name { font-size:11px; font-weight:600; color:#e4e4e7; margin-bottom:3px; }
  .ndb-kanban-card-sub { font-size:9px; color:#71717a; margin-bottom:4px; }
  .ndb-kanban-card-tags { display:flex; gap:3px; flex-wrap:wrap; }
  .ndb-kanban-card.dragging { opacity:0.4; border:1px dashed color-mix(in srgb, var(--g-primary) 30%, transparent); }
  .ndb-kanban-col.drag-over { background:color-mix(in srgb, var(--g-primary) 3%, transparent); border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); }
  .ndb-kanban-col.drag-over .ndb-kanban-cards { min-height:60px; }
  .ndb-kanban-drop-zone { min-height:40px; border:1px dashed color-mix(in srgb, var(--g-primary) 15%, transparent); margin:4px 0; display:none; align-items:center; justify-content:center; color:#3f3f46; font-size:9px; text-transform:uppercase; letter-spacing:0.1em; }
  .ndb-kanban-col.drag-over .ndb-kanban-drop-zone { display:flex; border-color:color-mix(in srgb, var(--g-primary) 30%, transparent); color:var(--g-primary); }
  .ndb-kanban-card[draggable="true"] { cursor:grab; }
  .ndb-kanban-card[draggable="true"]:active { cursor:grabbing; }

  /* Detail Panel */
  .ndb-detail { width:380px; flex-shrink:0; border-left:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); background:#060606; display:flex; flex-direction:column; overflow:hidden; animation:ndb-slide-in 0.2s ease-out; }
  @keyframes ndb-slide-in { from { transform:translateX(20px); opacity:0; } to { transform:translateX(0); opacity:1; } }
  .ndb-detail-header { padding:12px 16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); flex-shrink:0; }
  .ndb-detail-title { font-size:10px; text-transform:uppercase; letter-spacing:0.15em; color:var(--g-primary); font-weight:700; }
  .ndb-detail-close { background:none; border:none; color:#52525b; cursor:pointer; font-size:14px; padding:2px 6px; transition:color 0.12s; }
  .ndb-detail-close:hover { color:#e4e4e7; }
  .ndb-detail-body { flex:1; overflow-y:auto; padding:16px; }
  .ndb-detail-body::-webkit-scrollbar { width:3px; }
  .ndb-detail-body::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--g-primary) 10%, transparent); }
  .ndb-detail-avatar { width:56px; height:56px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:700; color:#fff; margin:0 auto 12px; }
  .ndb-detail-name { font-size:16px; font-weight:700; color:#e4e4e7; text-align:center; margin-bottom:12px; }
  .ndb-detail-section { margin-bottom:16px; }
  .ndb-detail-section-title { font-size:8px; text-transform:uppercase; letter-spacing:0.2em; color:var(--g-primary); margin-bottom:8px; font-weight:700; padding-bottom:4px; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .ndb-detail-field { display:flex; justify-content:space-between; align-items:flex-start; padding:4px 0; font-size:10px; gap:8px; }
  .ndb-detail-label { color:#71717a; white-space:nowrap; flex-shrink:0; }
  .ndb-detail-value { color:#a1a1aa; text-align:right; max-width:220px; overflow:hidden; text-overflow:ellipsis; word-break:break-word; }
  .ndb-detail-notes { font-size:10px; color:#a1a1aa; line-height:1.5; white-space:pre-wrap; background:#0a0a0a; padding:8px 10px; border:1px solid color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .ndb-detail-actions { display:flex; gap:6px; margin-top:16px; padding-top:12px; border-top:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); }

  /* Dialog */
  .ndb-dialog-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000; backdrop-filter:blur(4px); }
  .ndb-dialog { background:#0c0c0c; border:1px solid color-mix(in srgb, var(--g-primary) 20%, transparent); padding:24px; width:560px; max-width:92vw; max-height:85vh; overflow-y:auto; box-shadow:0 0 60px color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .ndb-dialog-title { font-size:13px; text-transform:uppercase; letter-spacing:0.15em; color:var(--g-primary); margin-bottom:16px; padding-bottom:10px; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); }
  .ndb-form-group { margin-bottom:14px; }
  .ndb-form-label { display:block; font-size:9px; text-transform:uppercase; letter-spacing:0.15em; color:#71717a; margin-bottom:5px; }
  .ndb-form-input { width:100%; padding:8px 10px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); color:#e4e4e7; font-family:inherit; font-size:11px; outline:none; transition:border-color 0.15s; box-sizing:border-box; }
  .ndb-form-input:focus { border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); box-shadow:0 0 8px color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .ndb-form-input::placeholder { color:#3f3f46; }
  .ndb-form-textarea { width:100%; padding:8px 10px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); color:#e4e4e7; font-family:inherit; font-size:11px; outline:none; transition:border-color 0.15s; box-sizing:border-box; resize:vertical; min-height:60px; line-height:1.5; }
  .ndb-form-textarea:focus { border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); box-shadow:0 0 8px color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .ndb-form-textarea::placeholder { color:#3f3f46; }
  .ndb-form-row { display:flex; gap:10px; }
  .ndb-form-row .ndb-form-group { flex:1; }
  .ndb-form-tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .ndb-form-tag { display:inline-flex; align-items:center; gap:3px; font-size:9px; padding:2px 6px; background:color-mix(in srgb, var(--g-primary) 6%, transparent); border:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); color:var(--g-primary); }
  .ndb-form-tag-remove { background:none; border:none; color:var(--g-primary); cursor:pointer; font-size:10px; padding:0 2px; line-height:1; }
  .ndb-form-tag-remove:hover { color:#f87171; }
  .ndb-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; padding-top:14px; border-top:1px solid color-mix(in srgb, var(--g-primary) 5%, transparent); }

  .ndb-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:60px 20px; color:#3f3f46; text-align:center; flex:1; }
  .ndb-empty-icon { font-size:40px; opacity:0.2; }
  .ndb-empty-text { font-size:11px; text-transform:uppercase; letter-spacing:0.15em; }
  .ndb-loading { text-align:center; padding:60px 20px; color:#52525b; font-size:12px; text-transform:uppercase; letter-spacing:0.15em; }
  .ndb-loading-dot { display:inline-block; animation:ndbPulse 1.5s infinite; color:var(--g-primary); }
  @keyframes ndbPulse { 0%,100%{opacity:0.3;} 50%{opacity:1;} }

  /* Discover */
  .ndb-discover-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px; max-height:400px; overflow-y:auto; }
  .ndb-discover-card { padding:12px; background:#080808; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); cursor:pointer; transition:all 0.15s; display:flex; align-items:center; gap:10px; }
  .ndb-discover-card:hover { border-color:color-mix(in srgb, var(--g-primary) 20%, transparent); background:#0a0a0a; }
  .ndb-discover-card.disabled { opacity:0.4; cursor:not-allowed; pointer-events:none; }
  .ndb-discover-icon { font-size:20px; flex-shrink:0; }
  .ndb-discover-name { font-size:11px; font-weight:600; color:#e4e4e7; }

  /* Block Content */
  .ndb-blocks { margin-top:4px; }
  .ndb-block { margin:2px 0; line-height:1.6; }
  .ndb-block p { margin:0; padding:2px 0; font-size:11px; color:#a1a1aa; }
  .ndb-block h1 { margin:12px 0 4px; font-size:16px; font-weight:700; color:#e4e4e7; }
  .ndb-block h2 { margin:10px 0 3px; font-size:14px; font-weight:700; color:#e4e4e7; }
  .ndb-block h3 { margin:8px 0 2px; font-size:12px; font-weight:700; color:#e4e4e7; }
  .ndb-block ul, .ndb-block ol { margin:2px 0; padding-left:18px; font-size:11px; color:#a1a1aa; }
  .ndb-block li { margin:1px 0; }
  .ndb-block-todo { display:flex; align-items:flex-start; gap:6px; padding:2px 0; font-size:11px; color:#a1a1aa; }
  .ndb-block-todo input { margin-top:3px; pointer-events:none; }
  .ndb-block-todo.checked { text-decoration:line-through; color:#52525b; }
  .ndb-block-toggle { margin:4px 0; }
  .ndb-block-toggle-header { display:flex; align-items:center; gap:6px; cursor:pointer; padding:3px 0; font-size:11px; color:#a1a1aa; transition:color 0.12s; }
  .ndb-block-toggle-header:hover { color:#e4e4e7; }
  .ndb-block-toggle-arrow { font-size:8px; transition:transform 0.15s; color:#52525b; }
  .ndb-block-toggle-arrow.open { transform:rotate(90deg); }
  .ndb-block-toggle-children { padding-left:16px; overflow:hidden; }
  .ndb-block-quote { border-left:2px solid color-mix(in srgb, var(--g-primary) 20%, transparent); padding:4px 0 4px 12px; margin:4px 0; font-size:11px; color:#a1a1aa; font-style:italic; }
  .ndb-block-callout { display:flex; gap:8px; padding:8px 10px; margin:4px 0; background:color-mix(in srgb, var(--g-primary) 3%, transparent); border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); font-size:11px; }
  .ndb-block-callout-icon { font-size:14px; flex-shrink:0; }
  .ndb-block-callout-content { flex:1; color:#a1a1aa; }
  .ndb-block-code { background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); padding:8px 10px; margin:4px 0; font-family:'JetBrains Mono','Fira Code',monospace; font-size:10px; color:#a1a1aa; overflow-x:auto; white-space:pre-wrap; position:relative; }
  .ndb-block-code-lang { position:absolute; top:4px; right:6px; font-size:7px; color:#3f3f46; text-transform:uppercase; letter-spacing:0.1em; }
  .ndb-block-image { margin:6px 0; max-width:100%; }
  .ndb-block-image img { max-width:100%; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .ndb-block-image-caption { font-size:9px; color:#52525b; margin-top:2px; }
  .ndb-block-bookmark { display:flex; align-items:center; gap:6px; padding:6px 10px; margin:4px 0; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); font-size:10px; transition:border-color 0.12s; }
  .ndb-block-bookmark:hover { border-color:color-mix(in srgb, var(--g-primary) 15%, transparent); }
  .ndb-block-bookmark a { color:#a78bfa; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ndb-block-divider { border:none; border-top:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); margin:8px 0; }
  .ndb-block-child-page { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; margin:3px 0; cursor:pointer; border:1px solid rgba(167,139,250,0.15); background:rgba(167,139,250,0.04); color:#a78bfa; font-size:10px; transition:all 0.12s; }
  .ndb-block-child-page:hover { border-color:rgba(167,139,250,0.35); background:rgba(167,139,250,0.08); color:#c4b5fd; }
  .ndb-block-child-db { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; margin:3px 0; border:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); background:color-mix(in srgb, var(--g-primary) 3%, transparent); color:var(--g-primary); font-size:10px; }
  .ndb-block-table { width:100%; border-collapse:collapse; margin:4px 0; font-size:10px; }
  .ndb-block-table th, .ndb-block-table td { padding:4px 8px; border:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); color:#a1a1aa; text-align:left; }
  .ndb-block-table th { background:color-mix(in srgb, var(--g-primary) 3%, transparent); color:var(--g-primary); font-size:9px; text-transform:uppercase; letter-spacing:0.05em; }
  .ndb-block-columns { display:flex; gap:12px; margin:4px 0; }
  .ndb-block-column { flex:1; min-width:0; }
  .ndb-block-children { padding-left:16px; }
  .ndb-block-unsupported { font-size:9px; color:#3f3f46; padding:2px 0; font-style:italic; }

  /* Breadcrumb */
  .ndb-breadcrumb { display:flex; align-items:center; gap:4px; flex-wrap:wrap; padding:6px 0; margin-bottom:8px; }
  .ndb-breadcrumb-item { font-size:9px; color:#52525b; cursor:pointer; transition:color 0.12s; }
  .ndb-breadcrumb-item:hover { color:var(--g-primary); }
  .ndb-breadcrumb-item.active { color:#a1a1aa; cursor:default; }
  .ndb-breadcrumb-sep { font-size:8px; color:#3f3f46; }

  /* Sub-pages section */
  .ndb-subpages { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; }

  /* Relation tags */
  .ndb-relation-tag { display:inline-flex; align-items:center; gap:3px; font-size:9px; padding:2px 6px; background:rgba(167,139,250,0.06); border:1px solid rgba(167,139,250,0.12); color:#a78bfa; cursor:pointer; transition:all 0.12s; }
  .ndb-relation-tag:hover { border-color:rgba(167,139,250,0.3); background:rgba(167,139,250,0.1); }

  /* Rich text annotations */
  .ndb-rt-bold { font-weight:700; }
  .ndb-rt-italic { font-style:italic; }
  .ndb-rt-strike { text-decoration:line-through; }
  .ndb-rt-underline { text-decoration:underline; }
  .ndb-rt-code { background:color-mix(in srgb, var(--g-primary) 6%, transparent); padding:1px 4px; font-family:'JetBrains Mono',monospace; font-size:0.9em; color:var(--g-primary); }
  .ndb-rt-link { color:#a78bfa; text-decoration:none; }
  .ndb-rt-link:hover { text-decoration:underline; }

  @media (max-width:900px) {
    .ndb-sidebar { width:100%; max-height:120px; border-right:none; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); }
    .ndb-sidebar-list { display:flex; overflow-x:auto; overflow-y:hidden; padding:4px; }
    .ndb-sidebar-item { flex-shrink:0; }
    .ndb-layout { flex-direction:column; }
    .ndb-detail { width:100%; position:fixed; inset:0; z-index:999; animation:ndb-slide-in 0.2s ease-out; }
    .ndb-grid { grid-template-columns:1fr; }
    .ndb-kanban-col { flex:0 0 220px; }
  }
</style>
`;

// ── Rich Text & Block Rendering ──────────────────────────────

function renderRichText(richText: any[]): any {
  if (!richText || !Array.isArray(richText) || richText.length === 0) return nothing;
  return richText.map((rt: any) => {
    const text = rt.plain_text ?? rt.text?.content ?? "";
    if (!text) return nothing;
    const ann = rt.annotations ?? {};
    const classes: string[] = [];
    if (ann.bold) classes.push("ndb-rt-bold");
    if (ann.italic) classes.push("ndb-rt-italic");
    if (ann.strikethrough) classes.push("ndb-rt-strike");
    if (ann.underline) classes.push("ndb-rt-underline");
    if (ann.code) classes.push("ndb-rt-code");

    const href = rt.href ?? rt.text?.link?.url ?? null;
    const colorStyle = ann.color && ann.color !== "default"
      ? ann.color.endsWith("_background")
        ? `background:${notionBg(ann.color.replace("_background", ""))};padding:1px 2px;`
        : `color:${notionColor(ann.color)};`
      : "";

    if (href) {
      return html`<a class="ndb-rt-link ${classes.join(" ")}" href="${href}" target="_blank" style="${colorStyle}">${text}</a>`;
    }
    if (classes.length > 0 || colorStyle) {
      return html`<span class="${classes.join(" ")}" style="${colorStyle}">${text}</span>`;
    }
    return text;
  });
}

function renderBlock(block: NotionBlock, state: AppViewState, client: GatewayBrowserClient, depth: number = 0): any {
  const ns = state.notionDbState;
  if (!ns) return nothing;
  const d = block.data ?? {};

  const renderChildren = () => {
    if (!block.children || block.children.length === 0) return nothing;
    return html`<div class="ndb-block-children">${block.children.map((c) => renderBlock(c, state, client, depth + 1))}</div>`;
  };

  switch (block.type) {
    case "paragraph":
      return html`<div class="ndb-block"><p>${renderRichText(d.rich_text)}</p>${renderChildren()}</div>`;

    case "heading_1":
      return html`<div class="ndb-block"><h1>${renderRichText(d.rich_text)}</h1>${renderChildren()}</div>`;
    case "heading_2":
      return html`<div class="ndb-block"><h2>${renderRichText(d.rich_text)}</h2>${renderChildren()}</div>`;
    case "heading_3":
      return html`<div class="ndb-block"><h3>${renderRichText(d.rich_text)}</h3>${renderChildren()}</div>`;

    case "bulleted_list_item":
      return html`<div class="ndb-block"><ul><li>${renderRichText(d.rich_text)}${renderChildren()}</li></ul></div>`;
    case "numbered_list_item":
      return html`<div class="ndb-block"><ol><li>${renderRichText(d.rich_text)}${renderChildren()}</li></ol></div>`;

    case "to_do": {
      const checked = d.checked ?? false;
      return html`<div class="ndb-block-todo ${checked ? "checked" : ""}"><input type="checkbox" .checked=${checked} />${renderRichText(d.rich_text)}${renderChildren()}</div>`;
    }

    case "toggle": {
      const isOpen = ns.expandedToggles.has(block.id);
      return html`
        <div class="ndb-block-toggle">
          <div class="ndb-block-toggle-header" @click=${() => toggleBlock(state, block.id)}>
            <span class="ndb-block-toggle-arrow ${isOpen ? "open" : ""}">▶</span>
            ${renderRichText(d.rich_text)}
          </div>
          ${isOpen ? html`<div class="ndb-block-toggle-children">${renderChildren()}</div>` : nothing}
        </div>
      `;
    }

    case "quote":
      return html`<div class="ndb-block-quote">${renderRichText(d.rich_text)}${renderChildren()}</div>`;

    case "callout": {
      const icon = d.icon?.emoji ?? d.icon?.external?.url ? "📌" : "💡";
      return html`
        <div class="ndb-block-callout">
          <span class="ndb-block-callout-icon">${d.icon?.emoji ?? icon}</span>
          <div class="ndb-block-callout-content">${renderRichText(d.rich_text)}${renderChildren()}</div>
        </div>
      `;
    }

    case "code": {
      const lang = d.language ?? "";
      const codeText = (d.rich_text ?? []).map((rt: any) => rt.plain_text ?? "").join("");
      return html`
        <div class="ndb-block-code">
          ${lang ? html`<span class="ndb-block-code-lang">${lang}</span>` : nothing}
          <pre style="margin:0;white-space:pre-wrap;">${codeText}</pre>
        </div>
      `;
    }

    case "image": {
      const url = d.file?.url ?? d.external?.url ?? "";
      const caption = (d.caption ?? []).map((c: any) => c.plain_text ?? "").join("");
      if (!url) return nothing;
      return html`
        <div class="ndb-block-image">
          <img src="${url}" alt="${caption || "image"}" loading="lazy" />
          ${caption ? html`<div class="ndb-block-image-caption">${caption}</div>` : nothing}
        </div>
      `;
    }

    case "bookmark": {
      const url = d.url ?? "";
      const caption = (d.caption ?? []).map((c: any) => c.plain_text ?? "").join("");
      return html`
        <div class="ndb-block-bookmark">
          <span>🔗</span>
          <a href="${url}" target="_blank">${caption || url}</a>
        </div>
      `;
    }

    case "divider":
      return html`<hr class="ndb-block-divider" />`;

    case "child_page":
      return html`
        <div class="ndb-block-child-page" @click=${() => navigateToSubPage(state, client, block.id, d.title ?? "Untitled")}>
          <span>📄</span> ${d.title ?? "Untitled"}
        </div>
      `;

    case "child_database":
      return html`
        <div class="ndb-block-child-db">
          <span>🗄️</span> ${d.title ?? "Untitled"} <span style="font-size:8px;color:#52525b;">(database)</span>
        </div>
      `;

    case "table": {
      if (!block.children || block.children.length === 0) return nothing;
      const hasColHeader = d.has_column_header ?? false;
      const hasRowHeader = d.has_row_header ?? false;
      return html`
        <table class="ndb-block-table">
          ${block.children.map((row, rowIdx) => {
            const cells = row.data?.cells ?? [];
            const isHeader = hasColHeader && rowIdx === 0;
            return html`<tr>${cells.map((cell: any[], colIdx: number) => {
              const isRowHeader = hasRowHeader && colIdx === 0;
              const tag = isHeader || isRowHeader ? "th" : "td";
              const content = renderRichText(cell);
              return tag === "th"
                ? html`<th>${content}</th>`
                : html`<td>${content}</td>`;
            })}</tr>`;
          })}
        </table>
      `;
    }

    case "table_row":
      return nothing; // handled by table

    case "column_list":
      return html`<div class="ndb-block-columns">${(block.children ?? []).map((c) => renderBlock(c, state, client, depth + 1))}</div>`;

    case "column":
      return html`<div class="ndb-block-column">${renderChildren()}</div>`;

    case "embed": {
      const url = d.url ?? "";
      return url ? html`<div class="ndb-block-bookmark"><span>🔗</span><a href="${url}" target="_blank">${url}</a></div>` : nothing;
    }

    case "video": {
      const url = d.file?.url ?? d.external?.url ?? "";
      return url ? html`<div class="ndb-block-bookmark"><span>🎬</span><a href="${url}" target="_blank">Video</a></div>` : nothing;
    }

    case "file": {
      const url = d.file?.url ?? d.external?.url ?? "";
      const caption = (d.caption ?? []).map((c: any) => c.plain_text ?? "").join("");
      return url ? html`<div class="ndb-block-bookmark"><span>📎</span><a href="${url}" target="_blank">${caption || "File"}</a></div>` : nothing;
    }

    case "pdf": {
      const url = d.file?.url ?? d.external?.url ?? "";
      return url ? html`<div class="ndb-block-bookmark"><span>📄</span><a href="${url}" target="_blank">PDF</a></div>` : nothing;
    }

    case "equation": {
      return html`<div class="ndb-block" style="font-style:italic;color:var(--g-primary);">${d.expression ?? ""}</div>`;
    }

    default:
      if (block.type === "synced_block" || block.type === "template" || block.type === "link_to_page" || block.type === "breadcrumb") {
        return renderChildren();
      }
      return html`<div class="ndb-block-unsupported">[${block.type}]</div>`;
  }
}

function renderBlockContent(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient): any {
  if (ns.blocksLoading) {
    return html`<div style="padding:8px 0;font-size:10px;color:#52525b;"><span class="ndb-loading-dot">◆</span> Loading content...</div>`;
  }
  if (ns.blocks.length === 0) {
    return html`<div style="padding:4px 0;font-size:9px;color:#3f3f46;">No content blocks</div>`;
  }

  // Group consecutive list items for proper rendering
  return html`<div class="ndb-blocks">${ns.blocks.map((b) => renderBlock(b, state, client, 0))}</div>`;
}

// ── Main Render ──────────────────────────────────────────────

export function renderNotionDatabases(state: AppViewState, client: GatewayBrowserClient) {
  const ns = state.notionDbState;
  if (!ns) return html`<div class="ndb-page g8-page">${ndbStyles}${g8GlassStyles}<div class="ndb-loading"><span class="ndb-loading-dot">◆</span> INITIALIZING</div></div>`;
  if (ns.loading && ns.databases.length === 0) return html`<div class="ndb-page g8-page">${ndbStyles}${g8GlassStyles}<div class="ndb-loading"><span class="ndb-loading-dot">◆</span> LOADING DATABASES</div></div>`;

  return html`
    <div class="ndb-page g8-page">
      ${ndbStyles}
      ${g8GlassStyles}
      ${ns.success ? html`<div class="ndb-success">${ns.success}</div>` : nothing}
      ${ns.error ? html`<div class="ndb-error"><span>⚠ ${ns.error}</span><button class="ndb-error-dismiss" @click=${() => { ns.error = null; state.requestUpdate?.(); }}>✕</button></div>` : nothing}
      <div class="ndb-layout">
        ${renderSidebar(state, ns, client)}
        <div class="ndb-main-area">
          ${ns.selectedDbId
            ? html`
                ${renderTopBar(state, ns, client)}
                ${renderNotionBar(state, ns, client)}
                <div class="ndb-content">
                  <div class="ndb-main">
                    ${ns.pagesLoading
                      ? html`<div class="ndb-loading"><span class="ndb-loading-dot">◆</span> LOADING PAGES</div>`
                      : ns.pages.length === 0
                        ? renderEmptyPages(state, ns, client)
                        : ns.viewMode === "grid"
                          ? renderGridView(state, ns, client)
                          : ns.viewMode === "table"
                            ? renderTableView(state, ns, client)
                            : renderKanbanView(state, ns, client)
                    }
                  </div>
                  ${ns.showDetailPanel && ns.detailPage ? renderDetailPanel(state, ns, client) : nothing}
                </div>
              `
            : renderNoDatabaseSelected(state, ns, client)
          }
        </div>
      </div>
      ${ns.showCreateDialog ? renderCreateDialog(state, ns, client) : nothing}
      ${ns.showEditDialog ? renderEditDialog(state, ns, client) : nothing}
      ${ns.showDeleteConfirm ? renderDeleteConfirm(state, ns, client) : nothing}
      ${ns.showDiscoverDialog ? renderDiscoverDialog(state, ns, client) : nothing}
      ${ns.detailPage
        ? html`<doc-agent-panel
            .client=${client as any}
            docType="db_row"
            .documentId=${ns.detailPage.id}
            .title=${(getPageTitle(ns.detailPage, ns.databases.find((d) => d.databaseId === ns.selectedDbId) as any) as string) || ns.detailPage.id}
            .databaseId=${ns.selectedDbId ?? ""}
            .extra=${`source=notion db=${ns.databases.find((d) => d.databaseId === ns.selectedDbId)?.name ?? "(unknown)"}`}
          ></doc-agent-panel>`
        : nothing}
    </div>
  `;
}

// ── Sidebar ──────────────────────────────────────────────────

function renderSidebar(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  return html`
    <div class="ndb-sidebar">
      <div class="ndb-sidebar-header">
        <span>◆ DATABASES</span>
        <span style="font-size:8px;color:#52525b;font-weight:400;">${ns.databases.length}</span>
      </div>
      <div class="ndb-sidebar-list">
        ${ns.databases.map((db) => html`
          <div class="ndb-sidebar-item ${ns.selectedDbId === db.databaseId ? "active" : ""}"
            @click=${() => selectDatabase(state, client, db.databaseId)}>
            <span class="ndb-sidebar-icon">${db.icon || "📄"}</span>
            <div class="ndb-sidebar-info">
              <div class="ndb-sidebar-name">${db.name}</div>
              <div class="ndb-sidebar-meta">${db.pageCount ?? 0} pages</div>
            </div>
            <div class="ndb-sidebar-actions">
              <button class="ndb-sidebar-action" title="Refresh schema"
                @click=${(e: Event) => { e.stopPropagation(); refreshDatabase(state, client, db.id); }}>↻</button>
              <button class="ndb-sidebar-action danger" title="Disconnect"
                @click=${(e: Event) => { e.stopPropagation(); removeDatabase(state, client, db.id); }}>✕</button>
            </div>
          </div>
        `)}
      </div>
      <div class="ndb-sidebar-add" @click=${() => { ns.showDiscoverDialog = true; ns.addDbUrl = ""; state.requestUpdate?.(); }}>
        <span>+</span>
        <span>Add Database</span>
      </div>
    </div>
  `;
}

// ── No Database Selected ─────────────────────────────────────

function renderNoDatabaseSelected(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  // Lazily hydrate the schema panel on first render. We attach it to the
  // AppViewState (typed loosely) so this widget keeps its own lifecycle
  // outside the strict NotionDbManagerState shape.
  const stateAny = state as unknown as {
    _notionSchemaPanel?: NotionSchemaPanelState;
    _notionImportWizard?: NotionImportWizardState;
    _notionConflictsPanel?: NotionConflictsPanelState;
    _notionSetupTab?: "connected" | "import" | "conflicts" | "page-sync";
    _notionPageSync?: {
      url: string;
      syncing: boolean;
      result: null | {
        title: string; noteId: string; isNew: boolean;
        subpages: Array<{id: string; title: string}>; mediaUrls: string[];
        tasksCreated: number; tasksUpdated: number; projectId: string;
        warnings: string[];
      };
      error: string | null;
    };
    cfg?: Record<string, unknown>;
  };
  if (!stateAny._notionImportWizard) {
    stateAny._notionImportWizard = createNotionImportWizardState();
  }
  if (!stateAny._notionConflictsPanel) {
    stateAny._notionConflictsPanel = createNotionConflictsPanelState();
  }
  if (!stateAny._notionSetupTab) stateAny._notionSetupTab = "connected";
  if (!stateAny._notionPageSync) {
    stateAny._notionPageSync = { url: "", syncing: false, result: null, error: null };
  }
  if (!stateAny._notionSchemaPanel) {
    stateAny._notionSchemaPanel = createNotionSchemaPanelState();
    // Fetch config once so the panel knows which dbIds to operate on. Re-
    // running on every render would hammer the gateway; subsequent
    // reconcile actions invalidate the relevant fields themselves.
    void (async () => {
      try {
        const cfg = (await (client as any).request("config.get", {})) as { config?: Record<string, unknown> };
        applyConfigToSchemaPanelState(stateAny._notionSchemaPanel!, cfg?.config ?? cfg);
        state.requestUpdate?.();
      } catch (e) {
        // Non-fatal; the panel will render with empty dbIds and the
        // operator can finish wizard setup to populate them.
      }
    })();
  }

  return html`
    <div class="ndb-empty" style="height:100%; padding: 20px; gap: 18px;">
      <div class="ndb-empty-icon">◇</div>
      <div class="ndb-empty-text">${ns.databases.length === 0 ? "NO DATABASES CONNECTED" : "SELECT A DATABASE"}</div>
      <div style="font-size:10px;color:#52525b;max-width:350px;">
        ${ns.databases.length === 0
          ? "Connect a Notion database to get started. Click \"Add Database\" to search your workspace or paste a database URL."
          : "Click a database on the left to view and manage its pages."}
      </div>
      ${ns.databases.length === 0 ? html`
        <button class="ndb-btn primary" @click=${() => { ns.showDiscoverDialog = true; state.requestUpdate?.(); }}>+ ADD DATABASE</button>
      ` : nothing}
      <div style="width: 100%; max-width: 880px; margin-top: 8px; display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; gap:6px;">
          <button
            class="ndb-btn ndb-btn-sm ${stateAny._notionSetupTab === "connected" ? "primary" : ""}"
            @click=${() => { stateAny._notionSetupTab = "connected"; state.requestUpdate?.(); }}
          >
            Connected DBs &amp; schema
          </button>
          <button
            class="ndb-btn ndb-btn-sm ${stateAny._notionSetupTab === "import" ? "primary" : ""}"
            @click=${() => { stateAny._notionSetupTab = "import"; state.requestUpdate?.(); }}
          >
            Import existing DBs
          </button>
          <button
            class="ndb-btn ndb-btn-sm ${stateAny._notionSetupTab === "conflicts" ? "primary" : ""}"
            @click=${() => {
              stateAny._notionSetupTab = "conflicts";
              void loadConflicts({
                client,
                state: stateAny._notionConflictsPanel!,
                requestUpdate: () => state.requestUpdate?.(),
              });
              state.requestUpdate?.();
            }}
          >
            Conflicts
          </button>
          <button
            class="ndb-btn ndb-btn-sm ${stateAny._notionSetupTab === "page-sync" ? "primary" : ""}"
            @click=${() => { stateAny._notionSetupTab = "page-sync"; state.requestUpdate?.(); }}
          >
            ⤓ Sync Page
          </button>
        </div>
        ${stateAny._notionSetupTab === "import"
          ? renderNotionImportWizard({
              client,
              state: stateAny._notionImportWizard!,
              requestUpdate: () => state.requestUpdate?.(),
            })
          : stateAny._notionSetupTab === "conflicts"
            ? renderNotionConflictsPanel({
                client,
                state: stateAny._notionConflictsPanel!,
                requestUpdate: () => state.requestUpdate?.(),
              })
            : stateAny._notionSetupTab === "page-sync"
              ? renderNotionPageSync(stateAny._notionPageSync!, client, () => state.requestUpdate?.())
              : renderNotionSchemaPanel({
                  client,
                  state: stateAny._notionSchemaPanel!,
                  requestUpdate: () => state.requestUpdate?.(),
                })}
      </div>
    </div>
  `;
}

// ── Notion Page Sync panel ───────────────────────────────────

type NotionPageSyncState = {
  url: string;
  syncing: boolean;
  result: null | {
    title: string; noteId: string; isNew: boolean;
    subpages: Array<{id: string; title: string}>; mediaUrls: string[];
    tasksCreated: number; tasksUpdated: number; projectId: string;
    warnings: string[];
  };
  error: string | null;
};

function renderNotionPageSync(
  ps: NotionPageSyncState,
  client: GatewayBrowserClient,
  requestUpdate: () => void,
) {
  const handleSync = async () => {
    if (ps.syncing || !ps.url.trim()) return;
    ps.syncing = true;
    ps.result = null;
    ps.error = null;
    requestUpdate();
    try {
      const res = await (client as any).request("notion.page.sync", { pageUrl: ps.url.trim() });
      if (res && typeof res === "object") {
        ps.result = res as typeof ps.result;
      } else {
        ps.error = "Unexpected response from gateway";
      }
    } catch (e) {
      ps.error = e instanceof Error ? e.message : String(e);
    } finally {
      ps.syncing = false;
      requestUpdate();
    }
  };

  return html`
    <div style="display:flex;flex-direction:column;gap:14px;max-width:680px;padding:4px 0;">
      <div style="font-size:11px;color:#a1a1aa;line-height:1.6;">
        Paste a Notion page URL to import its full content — all blocks, nested subpages, media,
        and checklist items — as a Note and Kanban project. Re-syncing the same page updates
        rather than duplicates.
      </div>

      <div style="display:flex;gap:8px;align-items:center;">
        <input
          type="url"
          placeholder="https://www.notion.so/My-Page-abc123…"
          style="flex:1;padding:8px 12px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e4e4e7;font-size:12px;outline:none;"
          .value=${ps.url}
          @input=${(e: Event) => { ps.url = (e.target as HTMLInputElement).value; requestUpdate(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void handleSync(); }}
        />
        <button
          class="ndb-btn primary"
          ?disabled=${ps.syncing || !ps.url.trim()}
          @click=${() => void handleSync()}
          style="white-space:nowrap;"
        >
          ${ps.syncing ? "Syncing…" : "⤓ Sync Page"}
        </button>
      </div>

      ${ps.error ? html`
        <div style="padding:10px 12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;color:#fca5a5;font-size:12px;">
          ⚠ ${ps.error}
        </div>
      ` : nothing}

      ${ps.result ? html`
        <div style="padding:12px 14px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.08);border-radius:10px;display:flex;flex-direction:column;gap:8px;">
          <div style="font-size:13px;font-weight:600;color:#e4e4e7;">
            ${ps.result.isNew ? "✓ Created" : "✓ Updated"}: ${ps.result.title}
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#a1a1aa;">
            <span>📝 Note <code style="opacity:.7;">${ps.result.noteId.slice(0, 12)}…</code></span>
            <span>📋 Kanban project</span>
            ${ps.result.tasksCreated > 0
              ? html`<span style="color:#5fd17a;">+${ps.result.tasksCreated} tasks created</span>`
              : nothing}
            ${ps.result.tasksUpdated > 0
              ? html`<span style="color:#6ea7ff;">${ps.result.tasksUpdated} tasks updated</span>`
              : nothing}
            ${ps.result.mediaUrls.length > 0
              ? html`<span>🖼 ${ps.result.mediaUrls.length} media URL${ps.result.mediaUrls.length !== 1 ? "s" : ""}</span>`
              : nothing}
          </div>
          ${ps.result.subpages.length > 0 ? html`
            <div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin-bottom:4px;">Subpages</div>
              <div style="display:flex;flex-wrap:wrap;gap:4px;">
                ${ps.result.subpages.map((s) => html`
                  <span style="padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);font-size:11px;color:#a3a3ad;">${s.title}</span>
                `)}
              </div>
            </div>
          ` : nothing}
          ${ps.result.warnings.length > 0 ? html`
            <div style="font-size:11px;color:#f5b542;">
              ${ps.result.warnings.map((w) => html`<div>⚠ ${w}</div>`)}
            </div>
          ` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Top Bar ──────────────────────────────────────────────────

function renderTopBar(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const db = ns.databases.find((d) => d.databaseId === ns.selectedDbId);
  const count = ns.pages.length;
  const groupableProps = getGroupableProperties(ns.schema);

  return html`
    <div class="ndb-topbar">
      <div class="ndb-topbar-left">
        <span class="ndb-badge">${db?.icon || "📄"} ${db?.name || "Database"}</span>
        <span class="ndb-count">${count} page${count !== 1 ? "s" : ""}</span>
        <div class="ndb-view-toggle">
          <button class="ndb-view-btn ${ns.viewMode === "grid" ? "active" : ""}" @click=${() => { ns.viewMode = "grid"; state.requestUpdate?.(); }}>⊞ Grid</button>
          <button class="ndb-view-btn ${ns.viewMode === "table" ? "active" : ""}" @click=${() => { ns.viewMode = "table"; state.requestUpdate?.(); }}>☰ Table</button>
          <button class="ndb-view-btn ${ns.viewMode === "kanban" ? "active" : ""}" @click=${() => { ns.viewMode = "kanban"; state.requestUpdate?.(); }}>⫏ Kanban</button>
        </div>
        ${ns.viewMode === "kanban" && groupableProps.length > 0 ? html`
          <select class="ndb-select" style="padding:3px 6px;"
            @change=${(e: Event) => { ns.kanbanGroupBy = (e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}>
            ${groupableProps.map((p) => html`
              <option value="${p.name}" ?selected=${ns.kanbanGroupBy === p.name}>Group: ${p.name}</option>
            `)}
          </select>
        ` : nothing}
      </div>
      <div class="ndb-topbar-right">
        <input class="ndb-search" type="text" placeholder="Search pages..."
          .value=${ns.searchQuery}
          @input=${(e: Event) => { ns.searchQuery = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }} />
        <button class="ndb-btn ndb-btn-sm" @click=${() => { ns.formData = {}; ns.showCreateDialog = true; state.requestUpdate?.(); }}>+ ADD</button>
        <button class="ndb-btn ndb-btn-sm" @click=${() => selectDatabase(state, client, ns.selectedDbId!)}>↻</button>
      </div>
    </div>
  `;
}

// ── Notion Bar ───────────────────────────────────────────────

function renderNotionBar(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const db = ns.databases.find((d) => d.databaseId === ns.selectedDbId);
  const lastSync = db?.lastSync ? new Date(db.lastSync).toLocaleString() : "never";
  const schemaCount = ns.schema ? Object.keys(ns.schema.properties).length : 0;

  return html`
    <div class="ndb-notion-bar">
      <span class="ndb-notion-dot connected"></span>
      <span>Notion: Connected</span>
      <span style="color:#52525b;">|</span>
      <span>Schema: ${schemaCount} properties</span>
      <span style="color:#52525b;">|</span>
      <span>Last pull: ${lastSync}</span>
      <span style="color:#52525b;">|</span>
      <span class="mono" style="color:#a78bfa;font-size:8px;" title="${ns.selectedDbId}">${ns.selectedDbId?.slice(0, 8)}…</span>
      <div style="margin-left:auto;display:flex;gap:4px;">
        <button class="ndb-btn ndb-btn-sm ndb-btn-notion" ?disabled=${ns.pulling}
          @click=${() => pullPages(state, client)}>
          ${ns.pulling ? "⟳ PULLING..." : "↓ PULL"}
        </button>
      </div>
    </div>
  `;
}

// ── Empty Pages ──────────────────────────────────────────────

function renderEmptyPages(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  return html`
    <div class="ndb-empty">
      <div class="ndb-empty-icon">◇</div>
      <div class="ndb-empty-text">NO PAGES</div>
      <div style="font-size:10px;color:#52525b;max-width:300px;">
        Pull pages from Notion or add one manually.
      </div>
      <div style="display:flex;gap:8px;">
        <button class="ndb-btn primary" @click=${() => { ns.formData = {}; ns.showCreateDialog = true; state.requestUpdate?.(); }}>+ ADD PAGE</button>
        <button class="ndb-btn ndb-btn-notion" @click=${() => pullPages(state, client)}>↓ PULL FROM NOTION</button>
      </div>
    </div>
  `;
}

// ── Grid View ────────────────────────────────────────────────

function renderGridView(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const filtered = getFilteredPages(ns);
  if (filtered.length === 0) return html`<div class="ndb-empty"><div class="ndb-empty-text" style="font-size:10px;">No pages match search</div></div>`;

  return html`<div class="ndb-grid">
    <div class="ndb-card" style="border:1px dashed color-mix(in srgb, var(--g-primary) 15%, transparent);display:flex;align-items:center;justify-content:center;min-height:120px;cursor:pointer;opacity:0.6;transition:all 0.2s;"
      @click=${() => { ns.formData = {}; ns.showCreateDialog = true; state.requestUpdate?.(); }}
      @mouseenter=${(e: Event) => ((e.target as HTMLElement).style.opacity = "1")}
      @mouseleave=${(e: Event) => ((e.target as HTMLElement).style.opacity = "0.6")}>
      <div style="text-align:center;color:var(--g-primary);">
        <div style="font-size:24px;margin-bottom:6px;">+</div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.15em;">New Page</div>
      </div>
    </div>
    ${filtered.map((p) => renderPageCard(state, ns, client, p))}
  </div>`;
}

function renderPageCard(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient, p: NotionPage) {
  const title = getPageTitle(p, ns.schema);
  const color = hashColor(title);
  const selected = ns.detailPage?.id === p.id && ns.showDetailPanel;

  const statusEntry = getFirstValue(p, ns.schema, "status") || getFirstValue(p, ns.schema, "select");
  const richText = getFirstValue(p, ns.schema, "rich_text");
  const email = getFirstValue(p, ns.schema, "email");
  const multiSelects: string[] = [];
  if (ns.schema) {
    for (const [pname, prop] of Object.entries(ns.schema.properties)) {
      if (prop.type === "multi_select" && Array.isArray(p.data?.[pname])) {
        multiSelects.push(...p.data[pname].slice(0, 3));
        if (multiSelects.length >= 3) break;
      }
    }
  }

  return html`
    <div class="ndb-card ${selected ? "selected" : ""}" @click=${() => { ns.detailPage = p; ns.showDetailPanel = true; state.requestUpdate?.(); }}>
      <div class="ndb-card-actions">
        <button class="ndb-card-action" @click=${(e: Event) => { e.stopPropagation(); openEditDialog(state, ns, p); }}>✎</button>
        <button class="ndb-card-action danger" @click=${(e: Event) => { e.stopPropagation(); ns.showDeleteConfirm = p.id; state.requestUpdate?.(); }}>✕</button>
      </div>
      <div class="ndb-card-header">
        <div class="ndb-avatar" style="background:${color}">${initials(title)}</div>
        <div class="ndb-card-info">
          <div class="ndb-card-name">${title}</div>
          ${richText ? html`<div class="ndb-card-sub">${String(richText.value).slice(0, 50)}</div>` : nothing}
        </div>
      </div>
      <div class="ndb-card-details">
        ${email ? html`<div class="ndb-card-detail"><span>✉</span><span>${email.value}</span></div>` : nothing}
      </div>
      <div class="ndb-card-footer">
        ${statusEntry ? html`
          <span class="ndb-status-badge" style="color:${notionColor(getOptionColor(ns.schema, statusEntry.name, statusEntry.value))};background:${notionBg(getOptionColor(ns.schema, statusEntry.name, statusEntry.value))};">
            ${statusEntry.value}
          </span>
        ` : nothing}
        ${multiSelects.length > 0 ? html`<div class="ndb-tags">${multiSelects.slice(0, 3).map((t) => html`<span class="ndb-tag">${t}</span>`)}</div>` : nothing}
        <span class="ndb-card-time">${timeAgo(p.lastEditedTime)}</span>
      </div>
    </div>
  `;
}

// ── Table View ───────────────────────────────────────────────

function renderTableView(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const filtered = getFilteredPages(ns);
  if (filtered.length === 0) return html`<div class="ndb-empty"><div class="ndb-empty-text" style="font-size:10px;">No pages match search</div></div>`;

  const columns: { name: string; prop: NotionPropertySchema }[] = [];
  if (ns.schema) {
    for (const [name, prop] of Object.entries(ns.schema.properties)) {
      if (prop.type === "title") columns.push({ name, prop });
    }
    const skipTypes = new Set(["title", "files"]);
    for (const [name, prop] of Object.entries(ns.schema.properties)) {
      if (!skipTypes.has(prop.type)) columns.push({ name, prop });
    }
  }
  const visibleCols = columns.slice(0, 10);

  const sortIcon = (col: string) => ns.sortBy === col ? (ns.sortDir === "asc" ? " ↑" : " ↓") : "";
  const toggleSort = (col: string) => {
    if (ns.sortBy === col) ns.sortDir = ns.sortDir === "asc" ? "desc" : "asc";
    else { ns.sortBy = col; ns.sortDir = "asc"; }
    state.requestUpdate?.();
  };

  return html`
    <div class="ndb-table-wrap">
      <table class="ndb-table">
        <thead>
          <tr>
            ${visibleCols.map((col) => html`
              <th class="${ns.sortBy === col.name ? "sorted" : ""}" @click=${() => toggleSort(col.name)}>
                ${col.name}${sortIcon(col.name)}
              </th>
            `)}
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((p) => {
            const title = getPageTitle(p, ns.schema);
            const color = hashColor(title);
            return html`
              <tr @click=${() => { ns.detailPage = p; ns.showDetailPanel = true; state.requestUpdate?.(); }}>
                ${visibleCols.map((col) => {
                  const val = p.data?.[col.name];
                  if (col.prop.type === "title") {
                    return html`<td><div class="ndb-table-name"><div class="ndb-table-avatar" style="background:${color}">${initials(title)}</div><span class="ndb-table-name-text">${val || "—"}</span></div></td>`;
                  }
                  if (col.prop.type === "select" || col.prop.type === "status") {
                    if (!val) return html`<td>—</td>`;
                    const optColor = getOptionColor(ns.schema, col.name, val);
                    return html`<td><span class="ndb-status-badge" style="color:${notionColor(optColor)};background:${notionBg(optColor)};">${val}</span></td>`;
                  }
                  if (col.prop.type === "multi_select") {
                    if (!Array.isArray(val) || val.length === 0) return html`<td>—</td>`;
                    return html`<td><div class="ndb-tags">${val.slice(0, 3).map((t: string) => html`<span class="ndb-tag">${t}</span>`)}</div></td>`;
                  }
                  if (col.prop.type === "number") return html`<td>${val != null ? val : "—"}</td>`;
                  if (col.prop.type === "date" || col.prop.type === "created_time" || col.prop.type === "last_edited_time") {
                    return html`<td style="color:#3f3f46;">${val ? new Date(val).toLocaleDateString() : "—"}</td>`;
                  }
                  if (col.prop.type === "checkbox") return html`<td>${val ? "✓" : "—"}</td>`;
                  return html`<td>${val || "—"}</td>`;
                })}
                <td style="color:#3f3f46;">${timeAgo(p.lastEditedTime)}</td>
                <td>
                  <button class="ndb-card-action" style="opacity:1;" @click=${(e: Event) => { e.stopPropagation(); openEditDialog(state, ns, p); }}>✎</button>
                </td>
              </tr>
            `;
          })}
          <tr style="cursor:pointer;opacity:0.5;transition:opacity 0.15s;" @click=${() => { ns.formData = {}; ns.showCreateDialog = true; state.requestUpdate?.(); }}
            @mouseenter=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "1")}
            @mouseleave=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "0.5")}>
            <td colspan="${visibleCols.length + 2}" style="text-align:center;padding:10px;color:var(--g-primary);font-size:10px;text-transform:uppercase;letter-spacing:0.1em;border:1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent);">+ New Page</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// ── Kanban View ──────────────────────────────────────────────

function renderKanbanView(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const groupProp = ns.kanbanGroupBy || getDefaultGroupBy(ns.schema);
  if (!groupProp) return html`<div class="ndb-empty"><div class="ndb-empty-text" style="font-size:10px;">No groupable properties in schema</div></div>`;

  const byGroup = getPagesByGroup(ns);
  const options = getGroupOptions(ns.schema, groupProp);
  const columnOrder = options.map((o) => o.name);
  if (byGroup["—"]?.length) columnOrder.push("—");

  const onDragStart = (e: DragEvent, pageId: string) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", pageId);
    e.dataTransfer.effectAllowed = "move";
    ns.kanbanDragPageId = pageId;
    state.requestUpdate?.();
    requestAnimationFrame(() => {
      (e.target as HTMLElement).classList.add("dragging");
    });
  };

  const onDragEnd = () => {
    ns.kanbanDragPageId = null;
    ns.kanbanDragOverCol = null;
    state.requestUpdate?.();
  };

  const onDragOver = (e: DragEvent, colName: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (ns.kanbanDragOverCol !== colName) {
      ns.kanbanDragOverCol = colName;
      state.requestUpdate?.();
    }
  };

  const onDragLeave = (e: DragEvent, colName: string) => {
    const relTarget = e.relatedTarget as HTMLElement | null;
    const colEl = e.currentTarget as HTMLElement;
    if (relTarget && colEl.contains(relTarget)) return;
    if (ns.kanbanDragOverCol === colName) {
      ns.kanbanDragOverCol = null;
      state.requestUpdate?.();
    }
  };

  const onDrop = async (e: DragEvent, targetCol: string) => {
    e.preventDefault();
    const pageId = e.dataTransfer?.getData("text/plain");
    ns.kanbanDragPageId = null;
    ns.kanbanDragOverCol = null;
    state.requestUpdate?.();

    if (!pageId || targetCol === "—") return;
    const page = ns.pages.find((p) => p.id === pageId);
    if (!page) return;
    if (page.data?.[groupProp] === targetCol) return;

    await updatePageProperty(state, client, pageId, groupProp, targetCol);
  };

  return html`
    <div class="ndb-kanban">
      ${columnOrder.map((colName) => {
        const pages = byGroup[colName] ?? [];
        const opt = options.find((o) => o.name === colName);
        const colColor = opt ? notionColor(opt.color) : "#6b7280";
        const isDragOver = ns.kanbanDragOverCol === colName;

        return html`
          <div class="ndb-kanban-col ${isDragOver ? "drag-over" : ""}"
            @dragover=${(e: DragEvent) => onDragOver(e, colName)}
            @dragleave=${(e: DragEvent) => onDragLeave(e, colName)}
            @drop=${(e: DragEvent) => onDrop(e, colName)}>
            <div class="ndb-kanban-header" style="color:${colColor};border-left:2px solid ${colColor};">
              ${colName}
              <span class="ndb-kanban-count">${pages.length}</span>
            </div>
            <div class="ndb-kanban-cards">
              ${colName !== "—" ? html`
                <div class="ndb-kanban-card" style="border:1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent);cursor:pointer;opacity:0.5;transition:opacity 0.15s;text-align:center;padding:6px 10px;"
                  @mouseenter=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "1")}
                  @mouseleave=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "0.5")}
                  @click=${() => { ns.formData = { [groupProp]: colName }; ns.showCreateDialog = true; state.requestUpdate?.(); }}>
                  <span style="color:var(--g-primary);font-size:9px;text-transform:uppercase;letter-spacing:0.1em;">+ New</span>
                </div>
              ` : nothing}
              ${pages.map((p) => {
                const title = getPageTitle(p, ns.schema);
                const isDragging = ns.kanbanDragPageId === p.id;
                const tags: string[] = [];
                if (ns.schema) {
                  for (const [pname, prop] of Object.entries(ns.schema.properties)) {
                    if (prop.type === "multi_select" && Array.isArray(p.data?.[pname])) {
                      tags.push(...p.data[pname].slice(0, 2));
                      if (tags.length >= 3) break;
                    }
                  }
                }
                const richText = getFirstValue(p, ns.schema, "rich_text");

                return html`
                  <div class="ndb-kanban-card ${isDragging ? "dragging" : ""}"
                    draggable="true"
                    @dragstart=${(e: DragEvent) => onDragStart(e, p.id)}
                    @dragend=${() => onDragEnd()}
                    @click=${() => { ns.detailPage = p; ns.showDetailPanel = true; state.requestUpdate?.(); }}>
                    <div class="ndb-kanban-card-name">${title}</div>
                    ${richText ? html`<div class="ndb-kanban-card-sub">${String(richText.value).slice(0, 40)}</div>` : nothing}
                    ${tags.length > 0 ? html`<div class="ndb-kanban-card-tags">${tags.map((t) => html`<span class="ndb-tag">${t}</span>`)}</div>` : nothing}
                  </div>
                `;
              })}
              <div class="ndb-kanban-drop-zone">DROP HERE</div>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

// ── Detail Panel ─────────────────────────────────────────────

function renderDetailPanel(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const p = ns.detailPage;
  if (!p) return nothing;
  const title = getPageTitle(p, ns.schema);
  const color = hashColor(title);

  // Auto-load blocks when detail panel opens (check if we need to load)
  const currentBlockPageId = ns.blockBreadcrumb.length > 0
    ? ns.blockBreadcrumb[ns.blockBreadcrumb.length - 1].id
    : p.id;
  if (!ns.blocksLoading && ns.blocks.length === 0 && !ns._detailLoadedFor) {
    (ns as any)._detailLoadedFor = p.id;
    loadPageBlocks(state, client, p.id);
  } else if ((ns as any)._detailLoadedFor !== p.id) {
    (ns as any)._detailLoadedFor = p.id;
    ns.blockBreadcrumb = [];
    ns.expandedToggles = new Set();
    loadPageBlocks(state, client, p.id);
  }

  // Collect relation properties to resolve
  const relationIds: string[] = [];
  if (ns.schema) {
    for (const [propName, prop] of Object.entries(ns.schema.properties)) {
      if (prop.type === "relation" && Array.isArray(p.data?.[propName])) {
        for (const rel of p.data[propName]) {
          if (rel?.id && !ns.relationCache[rel.id]) relationIds.push(rel.id);
        }
      }
    }
  }
  if (relationIds.length > 0 && !ns.relationLoading) {
    resolveRelations(state, client, relationIds);
  }

  const contactProps: [string, NotionPropertySchema][] = [];
  const statusProps: [string, NotionPropertySchema][] = [];
  const detailProps: [string, NotionPropertySchema][] = [];
  const numberProps: [string, NotionPropertySchema][] = [];
  const timeProps: [string, NotionPropertySchema][] = [];
  const relationProps: [string, NotionPropertySchema][] = [];
  const otherProps: [string, NotionPropertySchema][] = [];

  if (ns.schema) {
    for (const [propName, prop] of Object.entries(ns.schema.properties)) {
      if (prop.type === "title") continue;
      switch (prop.type) {
        case "email": case "phone_number": case "url": contactProps.push([propName, prop]); break;
        case "select": case "status": case "multi_select": case "checkbox": statusProps.push([propName, prop]); break;
        case "rich_text": detailProps.push([propName, prop]); break;
        case "number": numberProps.push([propName, prop]); break;
        case "date": case "created_time": case "last_edited_time": timeProps.push([propName, prop]); break;
        case "relation": relationProps.push([propName, prop]); break;
        default: otherProps.push([propName, prop]); break;
      }
    }
  }

  // Inline edit handler — updates property instantly + syncs to Notion
  const inlineUpdate = (propName: string, value: any) => {
    if (!p) return;
    if (p.data) p.data[propName] = value;
    state.requestUpdate?.();
    // Fire async update to backend + Notion
    const dbEntry = ns.databases.find((d) => d.databaseId === p.databaseId);
    if (dbEntry) {
      updatePageProperty(state, client, p.id, propName, value);
    }
  };

  const renderValue = (propName: string, prop: NotionPropertySchema) => {
    const val = p.data?.[propName];
    const readOnly = prop.type === "created_time" || prop.type === "last_edited_time" || prop.type === "files";

    // Inline editable select/status — dropdown
    if (prop.type === "select" || prop.type === "status") {
      const options = prop.options ?? [];
      const optColor = val ? getOptionColor(ns.schema, propName, val) : "default";
      return html`
        <select style="background:transparent;border:none;color:${val ? notionColor(optColor) : "#3f3f46"};font-family:inherit;font-size:9px;cursor:pointer;outline:none;padding:2px 4px;text-align:right;max-width:160px;appearance:none;-webkit-appearance:none;"
          @change=${(e: Event) => { inlineUpdate(propName, (e.target as HTMLSelectElement).value || null); }}>
          <option value="" ?selected=${!val}>— None —</option>
          ${options.map((o) => html`<option value="${o.name}" ?selected=${val === o.name}>${o.name}</option>`)}
        </select>
      `;
    }

    // Inline editable multi_select — clickable tags + add dropdown
    if (prop.type === "multi_select") {
      const selected = Array.isArray(val) ? val : [];
      const options = prop.options ?? [];
      return html`
        <div style="display:flex;flex-wrap:wrap;gap:3px;justify-content:flex-end;align-items:center;">
          ${selected.map((t: string) => {
            const optColor = getOptionColor(ns.schema, propName, t);
            return html`<span class="ndb-tag" style="color:${notionColor(optColor)};border-color:${notionColor(optColor)}30;background:${notionBg(optColor)};cursor:pointer;" 
              title="Click to remove"
              @click=${() => { inlineUpdate(propName, selected.filter((x: string) => x !== t)); }}>${t} ×</span>`;
          })}
          ${options.filter((o) => !selected.includes(o.name)).length > 0 ? html`
            <select style="background:transparent;border:1px dashed color-mix(in srgb, var(--g-primary) 10%, transparent);color:#52525b;font-family:inherit;font-size:8px;cursor:pointer;outline:none;padding:1px 3px;max-width:80px;"
              @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) inlineUpdate(propName, [...selected, v]); (e.target as HTMLSelectElement).value = ""; }}>
              <option value="">+</option>
              ${options.filter((o) => !selected.includes(o.name)).map((o) => html`<option value="${o.name}">${o.name}</option>`)}
            </select>
          ` : nothing}
          ${selected.length === 0 ? html`<span style="color:#3f3f46;">—</span>` : nothing}
        </div>
      `;
    }

    // Inline editable checkbox
    if (prop.type === "checkbox") {
      return html`<input type="checkbox" .checked=${!!val} style="cursor:pointer;" @change=${(e: Event) => { inlineUpdate(propName, (e.target as HTMLInputElement).checked); }} />`;
    }

    // Inline editable number
    if (prop.type === "number") {
      return html`<input type="number" style="background:transparent;border:none;border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent);color:#a1a1aa;font-family:inherit;font-size:10px;outline:none;width:80px;text-align:right;padding:2px 0;"
        .value=${val ?? ""}
        @change=${(e: Event) => { const v = (e.target as HTMLInputElement).value; inlineUpdate(propName, v ? parseFloat(v) : null); }} />`;
    }

    // Inline editable date
    if (prop.type === "date") {
      return html`<input type="date" style="background:transparent;border:none;color:#a1a1aa;font-family:inherit;font-size:10px;outline:none;cursor:pointer;padding:2px 0;"
        .value=${val || ""}
        @change=${(e: Event) => { inlineUpdate(propName, (e.target as HTMLInputElement).value || null); }} />`;
    }

    // Relations — render as tags
    if (prop.type === "relation") {
      const relations = Array.isArray(val) ? val : [];
      if (relations.length === 0) return html`<span style="color:#3f3f46;">—</span>`;
      return html`
        <div style="display:flex;flex-wrap:wrap;gap:3px;justify-content:flex-end;">
          ${relations.map((rel: any) => {
            const relTitle = ns.relationCache[rel.id] ?? rel.id?.slice(0, 8) + "…";
            return html`<span class="ndb-relation-tag" title="${rel.id}">↗ ${relTitle}</span>`;
          })}
        </div>
      `;
    }

    // Read-only types
    if (readOnly) {
      if (prop.type === "files") {
        if (!Array.isArray(val) || val.length === 0) return html`<span style="color:#3f3f46;">—</span>`;
        return html`${val.map((f: any) => html`<a href="${f.url}" target="_blank" style="color:#a78bfa;text-decoration:none;font-size:9px;display:block;">${f.name || "File"}</a>`)}`;
      }
      if (!val) return html`<span style="color:#3f3f46;">—</span>`;
      return html`<span>${new Date(val).toLocaleDateString()}</span>`;
    }

    // Inline editable text (url, email, phone, rich_text) — click to edit
    if (val === null || val === undefined || val === "") {
      // Empty: show clickable placeholder
      const inputType = prop.type === "email" ? "email" : prop.type === "url" ? "url" : prop.type === "phone_number" ? "tel" : "text";
      return html`<input type="${inputType}" placeholder="—" style="background:transparent;border:none;border-bottom:1px solid transparent;color:#3f3f46;font-family:inherit;font-size:10px;outline:none;text-align:right;max-width:180px;width:100%;padding:2px 0;transition:border-color 0.15s;"
        @focus=${(e: Event) => { (e.target as HTMLElement).style.borderColor = "color-mix(in srgb, var(--g-primary) 20%, transparent)"; }}
        @blur=${(e: Event) => { const el = e.target as HTMLInputElement; el.style.borderColor = "transparent"; if (el.value.trim()) inlineUpdate(propName, el.value.trim()); }} />`;
    }

    // Has value — show as editable
    if (prop.type === "url") {
      return html`<div style="display:flex;align-items:center;gap:4px;">
        <a href="${val}" target="_blank" style="color:#a78bfa;text-decoration:none;font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${String(val).slice(0, 30)}</a>
        <button style="background:none;border:none;color:#52525b;cursor:pointer;font-size:8px;padding:0;" @click=${() => {
          const newVal = prompt("Edit URL:", val);
          if (newVal !== null) inlineUpdate(propName, newVal || null);
        }}>✎</button>
      </div>`;
    }

    // Default: inline input
    return html`<input type="text" style="background:transparent;border:none;border-bottom:1px solid transparent;color:#a1a1aa;font-family:inherit;font-size:10px;outline:none;text-align:right;max-width:180px;width:100%;padding:2px 0;transition:border-color 0.15s;"
      .value=${String(val)}
      @focus=${(e: Event) => { (e.target as HTMLElement).style.borderColor = "color-mix(in srgb, var(--g-primary) 20%, transparent)"; }}
      @blur=${(e: Event) => { const el = e.target as HTMLInputElement; el.style.borderColor = "transparent"; inlineUpdate(propName, el.value.trim() || null); }} />`;
  };

  const renderSection = (sectionTitle: string, props: [string, NotionPropertySchema][]) => {
    if (props.length === 0) return nothing;
    return html`
      <div class="ndb-detail-section">
        <div class="ndb-detail-section-title">${sectionTitle}</div>
        ${props.map(([propName, prop]) => {
          const val = p.data?.[propName];
          if (prop.type === "rich_text" && typeof val === "string" && val.length > 60) {
            return html`<div style="margin-bottom:8px;"><div class="ndb-detail-label" style="margin-bottom:4px;">${propName}</div><div class="ndb-detail-notes">${val}</div></div>`;
          }
          return html`<div class="ndb-detail-field"><span class="ndb-detail-label">${propName}</span><span class="ndb-detail-value">${renderValue(propName, prop)}</span></div>`;
        })}
      </div>
    `;
  };

  return html`
    <div class="ndb-detail">
      <div class="ndb-detail-header">
        <span class="ndb-detail-title">◆ PAGE DETAILS</span>
        <button class="ndb-detail-close" @click=${() => { ns.showDetailPanel = false; ns.detailPage = null; state.requestUpdate?.(); }}>✕</button>
      </div>
      <div class="ndb-detail-body">
        <div class="ndb-detail-avatar" style="background:${color}">${initials(title)}</div>
        <div class="ndb-detail-name">${title}</div>

        ${renderSection("CONTACT", contactProps)}
        ${renderSection("STATUS & CATEGORIES", statusProps)}
        ${renderSection("DETAILS", detailProps)}
        ${renderSection("NUMBERS", numberProps)}
        ${renderSection("TIMELINE", timeProps)}
        ${relationProps.length > 0 ? renderSection("RELATIONS", relationProps) : nothing}
        ${otherProps.length > 0 ? renderSection("OTHER", otherProps) : nothing}

        <!-- Sub-Pages -->
        ${ns.subPages.length > 0 ? html`
          <div class="ndb-detail-section">
            <div class="ndb-detail-section-title">SUB-PAGES</div>
            <div class="ndb-subpages">
              ${ns.subPages.map((sp) => html`
                <div class="${sp.type === "page" ? "ndb-block-child-page" : "ndb-block-child-db"}"
                  @click=${() => sp.type === "page" ? navigateToSubPage(state, client, sp.id, sp.title) : null}>
                  <span>${sp.type === "page" ? "📄" : "🗄️"}</span> ${sp.title}
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        <!-- Page Content (Blocks) -->
        <div class="ndb-detail-section">
          <div class="ndb-detail-section-title">CONTENT</div>
          ${ns.blockBreadcrumb.length > 0 ? html`
            <div class="ndb-breadcrumb">
              <span class="ndb-breadcrumb-item" @click=${() => navigateBack(state, client, 0)}>${getPageTitle(p, ns.schema)}</span>
              ${ns.blockBreadcrumb.slice(1).map((bc, idx) => html`
                <span class="ndb-breadcrumb-sep">›</span>
                <span class="ndb-breadcrumb-item ${idx === ns.blockBreadcrumb.length - 2 ? "active" : ""}"
                  @click=${() => idx < ns.blockBreadcrumb.length - 2 ? navigateBack(state, client, idx + 1) : null}>
                  ${bc.title}
                </span>
              `)}
            </div>
          ` : nothing}
          ${renderBlockContent(state, ns, client)}
        </div>

        <div class="ndb-detail-section">
          <div class="ndb-detail-section-title">SYSTEM</div>
          <div class="ndb-detail-field"><span class="ndb-detail-label">Created</span><span class="ndb-detail-value">${new Date(p.createdTime).toLocaleString()}</span></div>
          <div class="ndb-detail-field"><span class="ndb-detail-label">Updated</span><span class="ndb-detail-value">${new Date(p.lastEditedTime).toLocaleString()}</span></div>
          <div class="ndb-detail-field"><span class="ndb-detail-label">Notion ID</span><span class="ndb-detail-value" style="font-size:8px;color:#52525b;">${p.id}</span></div>
        </div>

        <div class="ndb-detail-actions">
          <button class="ndb-btn ndb-btn-sm" @click=${() => openEditDialog(state, ns, p)}>✎ EDIT</button>
          <button class="ndb-btn ndb-btn-sm danger" @click=${() => { ns.showDeleteConfirm = p.id; state.requestUpdate?.(); }}>✕ DELETE</button>
        </div>
      </div>
    </div>
  `;
}

// ── Create / Edit / Delete Dialogs ───────────────────────────

function openEditDialog(state: AppViewState, ns: NotionDbManagerState, p: NotionPage) {
  ns.editingPage = p;
  ns.formData = { ...(p.data ?? {}) };
  ns.showEditDialog = true;
  state.requestUpdate?.();
}

function renderCreateDialog(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const titleProp = getTitleProperty(ns.schema);
  const hasTitle = titleProp ? !!ns.formData[titleProp]?.trim() : true;

  return html`
    <div class="ndb-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) { ns.showCreateDialog = false; state.requestUpdate?.(); } }}>
      <div class="ndb-dialog">
        <div class="ndb-dialog-title">◇ NEW PAGE</div>
        ${renderDynamicForm(state, ns)}
        <div class="ndb-dialog-actions">
          <button class="ndb-btn" @click=${() => { ns.showCreateDialog = false; ns.formData = {}; state.requestUpdate?.(); }}>CANCEL</button>
          <button class="ndb-btn primary" ?disabled=${ns.saving || !hasTitle} @click=${() => createPage(state, client)}>
            ${ns.saving ? "SAVING..." : "CREATE"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderEditDialog(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const titleProp = getTitleProperty(ns.schema);
  const hasTitle = titleProp ? !!ns.formData[titleProp]?.trim() : true;

  return html`
    <div class="ndb-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) { ns.showEditDialog = false; ns.editingPage = null; ns.formData = {}; state.requestUpdate?.(); } }}>
      <div class="ndb-dialog">
        <div class="ndb-dialog-title">◇ EDIT PAGE</div>
        ${renderDynamicForm(state, ns)}
        <div class="ndb-dialog-actions">
          <button class="ndb-btn" @click=${() => { ns.showEditDialog = false; ns.editingPage = null; ns.formData = {}; state.requestUpdate?.(); }}>CANCEL</button>
          <button class="ndb-btn primary" ?disabled=${ns.saving || !hasTitle} @click=${() => updatePage(state, client)}>
            ${ns.saving ? "SAVING..." : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderDeleteConfirm(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const pageId = ns.showDeleteConfirm;
  if (!pageId) return nothing;
  const page = ns.pages.find((p) => p.id === pageId);
  const title = page ? getPageTitle(page, ns.schema) : "this page";

  return html`
    <div class="ndb-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) { ns.showDeleteConfirm = null; state.requestUpdate?.(); } }}>
      <div class="ndb-dialog" style="width:400px;">
        <div class="ndb-dialog-title">⚠ ARCHIVE PAGE</div>
        <p style="font-size:11px;color:#a1a1aa;margin:0 0 16px;">
          Are you sure you want to archive <strong style="color:#e4e4e7;">${title}</strong>?
          This will archive the page in Notion (it can be restored there).
        </p>
        <div class="ndb-dialog-actions">
          <button class="ndb-btn" @click=${() => { ns.showDeleteConfirm = null; state.requestUpdate?.(); }}>CANCEL</button>
          <button class="ndb-btn danger" @click=${() => deletePage(state, client, pageId)}>ARCHIVE</button>
        </div>
      </div>
    </div>
  `;
}

// ── Dynamic Form ─────────────────────────────────────────────

function renderDynamicForm(state: AppViewState, ns: NotionDbManagerState) {
  if (!ns.schema) {
    return html`
      <div class="ndb-form-group">
        <label class="ndb-form-label">TITLE *</label>
        <input class="ndb-form-input" type="text" placeholder="Page title"
          .value=${ns.formData["Name"] || ""}
          @input=${(e: Event) => { ns.formData = { ...ns.formData, Name: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
      </div>
    `;
  }

  const titleFields: [string, NotionPropertySchema][] = [];
  const contactFields: [string, NotionPropertySchema][] = [];
  const selectFields: [string, NotionPropertySchema][] = [];
  const textFields: [string, NotionPropertySchema][] = [];
  const numberFields: [string, NotionPropertySchema][] = [];
  const dateFields: [string, NotionPropertySchema][] = [];
  const checkboxFields: [string, NotionPropertySchema][] = [];

  const skipFormTypes = new Set(["files", "created_time", "last_edited_time"]);

  for (const [propName, prop] of Object.entries(ns.schema.properties)) {
    if (skipFormTypes.has(prop.type)) continue;
    switch (prop.type) {
      case "title": titleFields.push([propName, prop]); break;
      case "email": case "phone_number": case "url": contactFields.push([propName, prop]); break;
      case "select": case "status": case "multi_select": selectFields.push([propName, prop]); break;
      case "rich_text": textFields.push([propName, prop]); break;
      case "number": numberFields.push([propName, prop]); break;
      case "date": dateFields.push([propName, prop]); break;
      case "checkbox": checkboxFields.push([propName, prop]); break;
    }
  }

  const renderField = ([propName, prop]: [string, NotionPropertySchema]) => {
    const val = ns.formData[propName];

    switch (prop.type) {
      case "title":
        return html`
          <div class="ndb-form-group">
            <label class="ndb-form-label">${propName} *</label>
            <input class="ndb-form-input" type="text" placeholder="${propName}"
              .value=${val || ""}
              @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;

      case "rich_text": {
        const isLong = propName.toLowerCase().includes("notes") || propName.toLowerCase().includes("description") || propName.toLowerCase().includes("research");
        if (isLong) {
          return html`
            <div class="ndb-form-group">
              <label class="ndb-form-label">${propName}</label>
              <textarea class="ndb-form-textarea" placeholder="${propName}" .value=${val || ""}
                @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLTextAreaElement).value }; state.requestUpdate?.(); }}></textarea>
            </div>
          `;
        }
        return html`
          <div class="ndb-form-group">
            <label class="ndb-form-label">${propName}</label>
            <input class="ndb-form-input" type="text" placeholder="${propName}" .value=${val || ""}
              @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;
      }

      case "email":
        return html`<div class="ndb-form-group"><label class="ndb-form-label">${propName}</label><input class="ndb-form-input" type="email" placeholder="email@example.com" .value=${val || ""} @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} /></div>`;
      case "phone_number":
        return html`<div class="ndb-form-group"><label class="ndb-form-label">${propName}</label><input class="ndb-form-input" type="tel" placeholder="+1 234 567 890" .value=${val || ""} @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} /></div>`;
      case "url":
        return html`<div class="ndb-form-group"><label class="ndb-form-label">${propName}</label><input class="ndb-form-input" type="url" placeholder="https://..." .value=${val || ""} @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} /></div>`;
      case "number":
        return html`<div class="ndb-form-group"><label class="ndb-form-label">${propName}</label><input class="ndb-form-input" type="number" placeholder="0" .value=${val ?? ""} @input=${(e: Event) => { const v = (e.target as HTMLInputElement).value; ns.formData = { ...ns.formData, [propName]: v ? parseFloat(v) : null }; state.requestUpdate?.(); }} /></div>`;
      case "date":
        return html`<div class="ndb-form-group"><label class="ndb-form-label">${propName}</label><input class="ndb-form-input" type="date" .value=${val || ""} @input=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} /></div>`;
      case "checkbox":
        return html`<div class="ndb-form-group" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" .checked=${!!val} @change=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLInputElement).checked }; state.requestUpdate?.(); }} /><label class="ndb-form-label" style="margin-bottom:0;">${propName}</label></div>`;

      case "select": case "status": {
        const options = prop.options ?? [];
        return html`
          <div class="ndb-form-group">
            <label class="ndb-form-label">${propName}</label>
            <select class="ndb-form-input" style="cursor:pointer;"
              @change=${(e: Event) => { ns.formData = { ...ns.formData, [propName]: (e.target as HTMLSelectElement).value || null }; state.requestUpdate?.(); }}>
              <option value="" ?selected=${!val}>— None —</option>
              ${options.map((o) => html`<option value="${o.name}" ?selected=${val === o.name}>${o.name}</option>`)}
            </select>
          </div>
        `;
      }

      case "multi_select": {
        const options = prop.options ?? [];
        const selected = Array.isArray(val) ? val : [];
        return html`
          <div class="ndb-form-group">
            <label class="ndb-form-label">${propName}</label>
            <div class="ndb-form-tags">
              ${selected.map((t: string) => html`
                <span class="ndb-form-tag">${t}<button class="ndb-form-tag-remove" @click=${() => {
                  ns.formData = { ...ns.formData, [propName]: selected.filter((x: string) => x !== t) };
                  state.requestUpdate?.();
                }}>×</button></span>
              `)}
            </div>
            <select class="ndb-form-input" style="cursor:pointer;margin-top:4px;"
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v && !selected.includes(v)) {
                  ns.formData = { ...ns.formData, [propName]: [...selected, v] };
                }
                (e.target as HTMLSelectElement).value = "";
                state.requestUpdate?.();
              }}>
              <option value="">+ Add ${propName}</option>
              ${options.filter((o) => !selected.includes(o.name)).map((o) => html`<option value="${o.name}">${o.name}</option>`)}
            </select>
          </div>
        `;
      }

      default: return nothing;
    }
  };

  return html`
    ${titleFields.map(renderField)}
    ${contactFields.length > 0 ? html`<div class="ndb-form-row">${contactFields.slice(0, 2).map(renderField)}</div>${contactFields.slice(2).map(renderField)}` : nothing}
    ${selectFields.map(renderField)}
    ${textFields.map(renderField)}
    ${numberFields.length > 0 ? html`<div class="ndb-form-row">${numberFields.slice(0, 2).map(renderField)}</div>${numberFields.slice(2).map(renderField)}` : nothing}
    ${dateFields.length > 0 ? html`<div class="ndb-form-row">${dateFields.slice(0, 2).map(renderField)}</div>${dateFields.slice(2).map(renderField)}` : nothing}
    ${checkboxFields.map(renderField)}
  `;
}

// ── Discover Dialog ──────────────────────────────────────────

function renderDiscoverDialog(state: AppViewState, ns: NotionDbManagerState, client: GatewayBrowserClient) {
  const connectedIds = new Set(ns.databases.map((d) => d.databaseId));

  return html`
    <div class="ndb-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) { ns.showDiscoverDialog = false; state.requestUpdate?.(); } }}>
      <div class="ndb-dialog" style="width:640px;">
        <div class="ndb-dialog-title">◇ ADD DATABASE</div>

        <div class="ndb-form-group">
          <label class="ndb-form-label">DATABASE URL OR ID</label>
          <div style="display:flex;gap:8px;">
            <input class="ndb-form-input" style="flex:1;" type="text" placeholder="Paste Notion database URL or ID..."
              .value=${ns.addDbUrl}
              @input=${(e: Event) => { ns.addDbUrl = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
              @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && ns.addDbUrl.trim()) addDatabase(state, client); }} />
            <button class="ndb-btn primary" ?disabled=${ns.adding || !ns.addDbUrl.trim()} @click=${() => addDatabase(state, client)}>
              ${ns.adding ? "CONNECTING..." : "CONNECT"}
            </button>
          </div>
        </div>

        <div style="text-align:center;padding:10px 0;font-size:9px;color:#3f3f46;text-transform:uppercase;letter-spacing:0.15em;">— OR —</div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <label class="ndb-form-label" style="margin-bottom:0;">DISCOVER WORKSPACE DATABASES</label>
          <button class="ndb-btn ndb-btn-sm ndb-btn-notion" ?disabled=${ns.discovering} @click=${() => discoverDatabases(state, client)}>
            ${ns.discovering ? "SEARCHING..." : "🔍 SEARCH"}
          </button>
        </div>

        ${ns.discoveredDbs.length > 0 ? html`
          <div class="ndb-discover-grid">
            ${ns.discoveredDbs.map((db) => {
              const isConnected = connectedIds.has(db.id);
              return html`
                <div class="ndb-discover-card ${isConnected ? "disabled" : ""}"
                  @click=${() => { if (!isConnected) addDatabaseById(state, client, db.id); }}>
                  <span class="ndb-discover-icon">${db.icon || "📄"}</span>
                  <div>
                    <div class="ndb-discover-name">${db.title}</div>
                    ${isConnected ? html`<div style="font-size:8px;color:#52525b;">Already connected</div>` : nothing}
                  </div>
                </div>
              `;
            })}
          </div>
        ` : nothing}

        <div class="ndb-dialog-actions">
          <button class="ndb-btn" @click=${() => { ns.showDiscoverDialog = false; ns.addDbUrl = ""; state.requestUpdate?.(); }}>CLOSE</button>
        </div>
      </div>
    </div>
  `;
}

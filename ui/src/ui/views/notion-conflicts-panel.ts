/**
 * <notion-conflicts-panel> — list + per-field resolver for the Notion
 * sync conflict queue.
 *
 * Renders one card per pending conflict. The operator can:
 *   - Accept all local values (push to Notion).
 *   - Accept all remote values (write to local).
 *   - Pick per-field side, then "Apply merge".
 *
 * RPCs consumed:
 *   notion.conflicts.list
 *   notion.conflicts.resolve
 *
 * Same callable / state-owned-by-parent pattern as the schema panel and
 * the import wizard so this widget can be dropped into any view.
 */
import { html, nothing, type TemplateResult } from "lit";
import { g8GlassStyles } from "./glass-g8.js";

import type { GatewayBrowserClient } from "../gateway";

interface ConflictFieldSide {
  value: unknown;
  type: string;
  updatedAt: string;
}

interface ConflictField {
  field: string;
  notionProperty: string;
  local: ConflictFieldSide;
  remote: ConflictFieldSide;
}

interface NotionConflict {
  id: string;
  notionDbId: string;
  notionPageId: string;
  role: string;
  title: string;
  detectedAt: number;
  fields: ConflictField[];
  status: "pending" | "resolved-local" | "resolved-remote" | "resolved-merged";
  resolvedAt: number | null;
}

export interface NotionConflictsPanelState {
  conflicts: NotionConflict[];
  /** Per-conflict per-field selection for merge mode. */
  selectionsByConflict: Record<string, Record<string, "local" | "remote">>;
  busyConflictIds: Set<string>;
  loading: boolean;
  error: string | null;
}

export function createNotionConflictsPanelState(): NotionConflictsPanelState {
  return {
    conflicts: [],
    selectionsByConflict: {},
    busyConflictIds: new Set(),
    loading: false,
    error: null,
  };
}

interface PanelActions {
  client: GatewayBrowserClient;
  state: NotionConflictsPanelState;
  requestUpdate: () => void;
}

async function rpc<T = unknown>(client: GatewayBrowserClient, method: string, params: unknown): Promise<T> {
  const fn = (client as any)?.request || (client as any)?.call || (client as any)?.invoke;
  if (!fn) throw new Error("gateway client has no request/call/invoke method");
  return fn.call(client, method, params) as Promise<T>;
}

export async function loadConflicts(opts: PanelActions): Promise<void> {
  opts.state.loading = true;
  opts.state.error = null;
  opts.requestUpdate();
  try {
    const res = await rpc<{ conflicts: NotionConflict[] }>(opts.client, "notion.conflicts.list", {
      status: "pending",
    });
    opts.state.conflicts = res.conflicts;
  } catch (e: any) {
    opts.state.error = `Failed to load conflicts: ${e?.message ?? String(e)}`;
  } finally {
    opts.state.loading = false;
    opts.requestUpdate();
  }
}

async function resolve(
  opts: PanelActions,
  conflict: NotionConflict,
  resolution: "local" | "remote" | "merge",
  selections?: Record<string, "local" | "remote">,
): Promise<void> {
  opts.state.busyConflictIds.add(conflict.id);
  opts.state.error = null;
  opts.requestUpdate();
  try {
    await rpc(opts.client, "notion.conflicts.resolve", {
      id: conflict.id,
      resolution,
      selections,
    });
    // Drop locally; the gateway also marks resolved server-side.
    opts.state.conflicts = opts.state.conflicts.filter((c) => c.id !== conflict.id);
    delete opts.state.selectionsByConflict[conflict.id];
  } catch (e: any) {
    opts.state.error = `Resolve failed: ${e?.message ?? String(e)}`;
  } finally {
    opts.state.busyConflictIds.delete(conflict.id);
    opts.requestUpdate();
  }
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function renderField(
  opts: PanelActions,
  conflict: NotionConflict,
  field: ConflictField,
): TemplateResult {
  const selections = opts.state.selectionsByConflict[conflict.id] ?? {};
  const choice = selections[field.field] ?? "remote";
  const setChoice = (c: "local" | "remote") => {
    selections[field.field] = c;
    opts.state.selectionsByConflict[conflict.id] = { ...selections };
    opts.requestUpdate();
  };
  return html`
    <tr>
      <td><code>${field.field}</code><br /><span class="ncp-mono">${field.notionProperty}</span></td>
      <td>
        <label class=${`ncp-side ${choice === "local" ? "ncp-side-active" : ""}`}>
          <input type="radio" name=${`f-${conflict.id}-${field.field}`} ?checked=${choice === "local"} @change=${() => setChoice("local")} />
          <strong>Local:</strong> ${fmtValue(field.local.value)}
        </label>
      </td>
      <td>
        <label class=${`ncp-side ${choice === "remote" ? "ncp-side-active" : ""}`}>
          <input type="radio" name=${`f-${conflict.id}-${field.field}`} ?checked=${choice === "remote"} @change=${() => setChoice("remote")} />
          <strong>Notion:</strong> ${fmtValue(field.remote.value)}
        </label>
      </td>
    </tr>
  `;
}

function renderConflict(opts: PanelActions, c: NotionConflict): TemplateResult {
  const busy = opts.state.busyConflictIds.has(c.id);
  return html`
    <article class="ncp-card">
      <header class="ncp-card-head">
        <strong>${c.title || "Untitled"}</strong>
        <span class="ncp-pill">${c.role}</span>
        <span class="ncp-mono">DB ${c.notionDbId.slice(0, 8)}…</span>
        <span class="ncp-spacer"></span>
        <span class="ncp-muted">${new Date(c.detectedAt).toLocaleString()}</span>
      </header>
      <table class="ncp-table">
        <thead>
          <tr><th>Field</th><th>Local</th><th>Notion</th></tr>
        </thead>
        <tbody>
          ${c.fields.map((f) => renderField(opts, c, f))}
        </tbody>
      </table>
      <div class="ncp-actions">
        <button class="ncp-btn" ?disabled=${busy} @click=${() => void resolve(opts, c, "local")}>
          Keep local (push to Notion)
        </button>
        <button class="ncp-btn" ?disabled=${busy} @click=${() => void resolve(opts, c, "remote")}>
          Keep Notion (overwrite local)
        </button>
        <button
          class="ncp-btn ncp-btn-primary"
          ?disabled=${busy}
          @click=${() => void resolve(opts, c, "merge", opts.state.selectionsByConflict[c.id] ?? {})}
        >
          Apply per-field merge
        </button>
      </div>
    </article>
  `;
}

export function renderNotionConflictsPanel(opts: PanelActions): TemplateResult {
  injectStyles();
  return html`
    ${g8GlassStyles}
    <section class="ncp g8-page">
      <header class="ncp-head-strip">
        <span class="ncp-title">Notion sync conflicts</span>
        <span class="ncp-pill ${opts.state.conflicts.length > 0 ? "ncp-pill-warn" : "ncp-pill-ok"}">
          ${opts.state.conflicts.length} pending
        </span>
        <span class="ncp-spacer"></span>
        <button class="ncp-btn" ?disabled=${opts.state.loading} @click=${() => void loadConflicts(opts)}>
          ${opts.state.loading ? "Loading…" : "Refresh"}
        </button>
      </header>
      ${opts.state.error ? html`<div class="ncp-error">${opts.state.error}</div>` : nothing}
      ${opts.state.conflicts.length === 0
        ? html`<div class="ncp-empty">No pending conflicts.</div>`
        : opts.state.conflicts.map((c) => renderConflict(opts, c))}
    </section>
  `;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "infinibot-notion-conflicts-panel-styles";
  style.textContent = NCP_STYLES;
  document.head.appendChild(style);
}

const NCP_STYLES = `
.ncp { border:1px solid rgba(250,204,21,0.16); background:linear-gradient(180deg, rgba(250,204,21,0.04), rgba(0,0,0,0.18)); border-radius:12px; padding:12px 14px; color:var(--c-fg, #f5f5f4); font-size:13px; }
.ncp-head-strip { display:flex; align-items:center; gap:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.06); margin-bottom:8px; }
.ncp-title { font-weight:600; font-size:14px; }
.ncp-spacer { flex:1; }
.ncp-empty { padding:24px; text-align:center; opacity:0.55; }
.ncp-error { color:#ef5b5b; font-size:12px; padding:6px 8px; background:rgba(239,91,91,0.08); border-radius:4px; margin-bottom:8px; }
.ncp-card { padding:10px 12px; margin:8px 0; background:rgba(0,0,0,0.18); border-radius:8px; border:1px solid rgba(255,255,255,0.04); }
.ncp-card-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.ncp-mono { font-family:ui-monospace,SFMono-Regular,monospace; font-size:11px; opacity:0.55; }
.ncp-muted { opacity:0.55; font-size:11px; }
.ncp-pill { font-size:11px; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,0.06); color:#a3a3ad; }
.ncp-pill-ok { color:#5fd17a; background:rgba(95,209,122,0.08); }
.ncp-pill-warn { color:#f5b542; background:rgba(245,181,66,0.08); }
.ncp-table { width:100%; border-collapse:collapse; margin:8px 0; }
.ncp-table th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:#71717a; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.08); }
.ncp-table td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:12px; vertical-align:top; }
.ncp-side { display:flex; align-items:flex-start; gap:6px; padding:4px 6px; border-radius:4px; cursor:pointer; }
.ncp-side input { margin-top:2px; cursor:pointer; }
.ncp-side-active { background:rgba(245,181,66,0.08); }
.ncp-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.04); }
.ncp-btn { font:inherit; cursor:pointer; padding:6px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:inherit; font-size:12px; }
.ncp-btn:disabled { opacity:0.5; cursor:progress; }
.ncp-btn:hover:not(:disabled) { background:rgba(255,255,255,0.1); }
.ncp-btn-primary { border-color:rgba(245,181,66,0.5); background:rgba(245,181,66,0.12); color:#ffc861; }
.ncp-btn-primary:hover:not(:disabled) { background:rgba(245,181,66,0.22); }
`;

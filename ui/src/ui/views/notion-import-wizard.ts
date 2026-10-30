/**
 * <notion-import-wizard> — embeddable view for the unified Notion import flow.
 *
 * Six logical steps, rendered as a single scrollable panel so the operator
 * can see context across stages without losing earlier choices:
 *   1. Connect       — token (delegated to notion.wizard.verifyToken)
 *   2. Discover      — list every DB the integration can see
 *   3. Roles         — pick a role per selected DB (auto-suggested)
 *   4. Field mapping — diff per DB, edit fieldMap, optionally apply patch
 *   5. Relations     — surface cross-DB relations + offer to import related DBs
 *   6. Commit        — write bindings, run initial backfill
 *
 * Same callable pattern as notion-schema-panel: the parent view owns the
 * state, calls render() with it, and gets a re-render via `requestUpdate`.
 *
 * RPCs consumed (all backed by the gateway/setup-ui dispatch):
 *   notion.wizard.verifyToken
 *   notion.import.listDatabases
 *   notion.import.preview
 *   notion.import.scanRelations
 *   notion.import.commit
 *   notion.import.unbind
 */
import { html, nothing, type TemplateResult } from "lit";
import { g8GlassStyles } from "./glass-g8.js";

import type { GatewayBrowserClient } from "../gateway";

export type ImportRoleId =
  | "projects"
  | "tasks"
  | "clients"
  | "leads"
  | "companies"
  | "deals"
  | "contacts"
  | "products"
  | "custom";

export type WizardStep = "connect" | "discover" | "roles" | "mapping" | "relations" | "commit";

interface DiscoveredDb {
  id: string;
  title: string;
  url?: string;
  lastEditedAt: number;
  propertyCount: number;
  isSystemManaged: boolean;
  propertyNames: string[];
  suggestedRole: ImportRoleId;
  existingBinding: {
    role: ImportRoleId;
    conflictPolicy: "queue" | "last-write-wins";
    fieldMap: Record<string, string>;
    lastSyncedAt: number | null;
  } | null;
}

interface PreviewResult {
  dbId: string;
  role: ImportRoleId;
  propertyNames: string[];
  properties: Array<{ name: string; type: string }>;
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
    titleProp: string | null;
  } | null;
  proposedFieldMap: Record<string, string>;
}

interface RelationLink {
  sourceDbId: string;
  sourceProp: string;
  targetDbId: string;
  targetTitle: string;
  targetIsKnown: boolean;
}

export interface NotionImportWizardState {
  step: WizardStep;
  /** Token typed by the user. Cleared after a successful verify. */
  apiKey: string;
  tokenVerified: boolean;
  integrationName: string | null;
  workspace: string | null;
  /** Selected DB ids on the discover step. */
  selectedDbIds: Set<string>;
  /** All DBs returned by discover. */
  discovered: DiscoveredDb[];
  /** Per-DB role override (defaults to suggestedRole until the user changes it). */
  roleByDb: Record<string, ImportRoleId>;
  /** Per-DB conflict policy override. */
  conflictPolicyByDb: Record<string, "queue" | "last-write-wins">;
  /** Per-DB preview (lazy-loaded when entering the mapping step). */
  previewByDb: Record<string, PreviewResult>;
  /** Per-DB editable field map; seeded from preview.proposedFieldMap. */
  fieldMapByDb: Record<string, Record<string, string>>;
  /** Per-DB "apply additive patch on commit" flag. */
  applyPatchByDb: Record<string, boolean>;
  /** Relations scan result (only populated after the relations step runs). */
  relations: RelationLink[];
  /** Per-target-db decision: import or skip. */
  importRelatedByDb: Record<string, boolean>;
  /** Spinner / disabled state for the active step. */
  busy: boolean;
  /** Surface error from a recent action; cleared on next successful action. */
  error: string | null;
  /** Successful commit summary so the final screen can show counts. */
  commitSummary: {
    committed: number;
    pulled: { projects: number; tasks: number; conflicts: number } | null;
  } | null;
  /**
   * Transient: have we asked the gateway whether Notion is already set
   * up? Lets us auto-skip the connect step when an existing API key is
   * already validated, so users don't re-paste a working token every
   * time they reopen the wizard from a different surface.
   */
  initChecked: boolean;
  /**
   * Operator-pasted Notion DB URLs/IDs that should be probed via
   * /databases/{id} on the next discover call. Lets the user import a DB
   * Notion's /search refuses to list (e.g. integration was added to a
   * parent page but not the database itself, or the DB was shared
   * directly but /search is lagging).
   */
  manualDbIds: string[];
  manualDbInput: string;
}

export function createNotionImportWizardState(): NotionImportWizardState {
  return {
    // Open straight onto Discover — matches the change-notion-db modal,
    // which never asks for a token. The wizard will bounce to Connect
    // automatically if the gateway can't list databases (no key, auth
    // failed). Saves a paint on the "Checking for existing Notion
    // connection…" placeholder for the 99% case where the key already
    // exists.
    step: "discover",
    apiKey: "",
    tokenVerified: true,
    integrationName: null,
    workspace: null,
    selectedDbIds: new Set(),
    discovered: [],
    roleByDb: {},
    conflictPolicyByDb: {},
    previewByDb: {},
    fieldMapByDb: {},
    applyPatchByDb: {},
    relations: [],
    importRelatedByDb: {},
    busy: false,
    error: null,
    commitSummary: null,
    initChecked: false,
    manualDbIds: [],
    manualDbInput: "",
  };
}

/**
 * Extract a Notion database id from a URL or raw id string. Accepts:
 *   - bare 32-char hex (no dashes)
 *   - dashed UUID
 *   - https://www.notion.so/Workspace/Name-<32hex>
 *   - https://www.notion.so/<32hex>?v=...
 * Returns null when no id can be confidently extracted.
 */
function extractNotionDbId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
  );
  return match ? match[1] : null;
}

/**
 * On wizard mount, check whether Notion is already configured by an
 * earlier flow (CRM sync, projects setup, etc.). If a working API key
 * is present, mark the wizard token-verified and jump straight to the
 * discover step — the user shouldn't have to re-paste a token they've
 * already validated.
 *
 * Idempotent: state.initChecked guards against repeat firing across
 * re-renders. We DON'T need the apiKey on the client because every
 * downstream step (notion.import.listDatabases, preview, commit) reads
 * the gateway-stored key via getNotionApiKeyOrNull().
 */
async function checkExistingConnection(opts: WizardActions): Promise<void> {
  if (opts.state.initChecked) return;
  opts.state.initChecked = true;
  // Match the change-notion-db modal: skip the /users/me probe and the
  // Connect step entirely, just jump straight to Discover. If the gateway
  // already has a Notion key (env var or infinibot.json) the import RPC
  // will use it; if it doesn't, the discover call surfaces NOT_CONFIGURED
  // and `loadDiscovery` bounces back to the connect step automatically.
  opts.state.tokenVerified = true;
  opts.state.step = "discover";
  // Try to pull the integration name in the background so the header can
  // show "Connected to <name>" — non-blocking, ignore errors.
  void (async () => {
    try {
      const res = await rpc<{
        notion: { reachable?: boolean; integrationName?: string | null };
      }>(opts.client, "notion.wizard.status", {});
      if (res.notion.integrationName) {
        opts.state.integrationName = res.notion.integrationName;
        opts.requestUpdate();
      }
    } catch {
      /* status is just decoration — silent on failure */
    }
  })();
  opts.requestUpdate();
  void loadDiscovery(opts);
}

interface WizardActions {
  client: GatewayBrowserClient;
  state: NotionImportWizardState;
  requestUpdate: () => void;
}

async function rpc<T = unknown>(
  client: GatewayBrowserClient,
  method: string,
  params: unknown,
): Promise<T> {
  const fn =
    (client as any)?.request || (client as any)?.call || (client as any)?.invoke;
  if (!fn) throw new Error("gateway client has no request/call/invoke method");
  return fn.call(client, method, params) as Promise<T>;
}

function setBusy(state: NotionImportWizardState, busy: boolean): void {
  state.busy = busy;
  if (busy) state.error = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Step actions
// ─────────────────────────────────────────────────────────────────────────

async function verifyToken(opts: WizardActions): Promise<void> {
  if (!opts.state.apiKey.trim()) {
    opts.state.error = "Paste a Notion integration token first.";
    opts.requestUpdate();
    return;
  }
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<{
      ok: boolean;
      hint?: string;
      integrationName?: string;
      workspace?: string;
    }>(opts.client, "notion.wizard.verifyToken", { apiKey: opts.state.apiKey.trim() });
    if (!res.ok) {
      opts.state.error = res.hint ?? "Notion rejected this token.";
      opts.state.tokenVerified = false;
      return;
    }
    opts.state.tokenVerified = true;
    opts.state.integrationName = res.integrationName ?? null;
    opts.state.workspace = res.workspace ?? null;
    opts.state.step = "discover";
  } catch (e: any) {
    opts.state.error = `Token verify failed: ${e?.message ?? String(e)}`;
    return;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
  // Kick discovery as a follow-up rather than chaining it inside the
  // verify busy-state — a slow listDatabases used to make the whole flow
  // read as "stuck verifying" even after verify itself returned. Now the
  // wizard pops onto the Discover step immediately and shows discovery's
  // own busy spinner while databases load.
  void loadDiscovery(opts);
}

async function loadDiscovery(opts: WizardActions): Promise<void> {
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<{ databases: DiscoveredDb[] }>(
      opts.client,
      "notion.import.listDatabases",
      { manualIds: opts.state.manualDbIds },
    );
    console.log("[import-wizard] notion.import.listDatabases →", {
      count: res.databases?.length ?? 0,
      manualIds: opts.state.manualDbIds,
      sample: (res.databases ?? []).slice(0, 3).map((d) => ({ id: d.id, title: d.title })),
    });
    opts.state.discovered = res.databases;
    // Seed role overrides from the suggestion so the UI starts with a
    // reasonable default the user can edit.
    const roleByDb: Record<string, ImportRoleId> = {};
    const policyByDb: Record<string, "queue" | "last-write-wins"> = {};
    for (const db of res.databases) {
      roleByDb[db.id] = db.existingBinding?.role ?? db.suggestedRole;
      policyByDb[db.id] = db.existingBinding?.conflictPolicy ?? "queue";
    }
    opts.state.roleByDb = roleByDb;
    opts.state.conflictPolicyByDb = policyByDb;
  } catch (e: any) {
    const code = e?.code ?? e?.cause?.code ?? "";
    const msg = e?.message ?? String(e);
    // Auth / not-configured failures mean the gateway has no usable key —
    // bounce back to the Connect step so the user can paste one. Other
    // failures (rate-limited, network) stay on Discover with the error
    // displayed so the user can retry without re-entering the token.
    const isAuthish = code === "NOT_CONFIGURED" ||
      code === "NOTION_AUTH_FAILED" ||
      /401|invalid api token|invalid_api_key|not configured/i.test(msg);
    if (isAuthish) {
      opts.state.step = "connect";
      opts.state.tokenVerified = false;
      opts.state.error = "Notion API key missing or invalid. Paste your integration token to continue.";
    } else {
      let hint = "";
      if (code === "NOTION_FORBIDDEN" || /403|restricted_resource/i.test(msg)) {
        hint = " — the integration doesn't have access to any databases. Open Notion → top-right '…' → Connections → add this integration to your databases.";
      } else if (code === "NOTION_RATE_LIMITED" || /429/.test(msg)) {
        hint = " — Notion rate-limited the request. Wait a minute and try again.";
      }
      opts.state.error = `Discovery failed: ${msg}${hint}`;
    }
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

function toggleSelected(opts: WizardActions, dbId: string): void {
  if (opts.state.selectedDbIds.has(dbId)) opts.state.selectedDbIds.delete(dbId);
  else opts.state.selectedDbIds.add(dbId);
  opts.requestUpdate();
}

async function goToRoles(opts: WizardActions): Promise<void> {
  if (opts.state.selectedDbIds.size === 0) {
    opts.state.error = "Select at least one database to import.";
    opts.requestUpdate();
    return;
  }
  opts.state.step = "roles";
  opts.state.error = null;
  opts.requestUpdate();
}

async function goToMapping(opts: WizardActions): Promise<void> {
  opts.state.step = "mapping";
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    // Preview each selected DB in parallel — the operator goes straight
    // to a populated mapping table instead of waiting per-row.
    const ids = Array.from(opts.state.selectedDbIds);
    const previews = await Promise.all(
      ids.map(async (id) => {
        try {
          return await rpc<PreviewResult>(opts.client, "notion.import.preview", {
            dbId: id,
            role: opts.state.roleByDb[id] ?? "custom",
          });
        } catch {
          return null;
        }
      }),
    );
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const preview = previews[i];
      if (preview) {
        opts.state.previewByDb[id] = preview;
        opts.state.fieldMapByDb[id] = { ...preview.proposedFieldMap };
        opts.state.applyPatchByDb[id] = preview.diff?.satisfiesRequired === false;
      }
    }
  } catch (e: any) {
    opts.state.error = `Preview failed: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

async function goToRelations(opts: WizardActions): Promise<void> {
  opts.state.step = "relations";
  setBusy(opts.state, true);
  opts.requestUpdate();
  try {
    const res = await rpc<{ relations: RelationLink[] }>(
      opts.client,
      "notion.import.scanRelations",
      { dbIds: Array.from(opts.state.selectedDbIds) },
    );
    opts.state.relations = res.relations;
    // Default: import related DBs the user hasn't already selected (the
    // common case is "yes, of course I want the linked Projects DB too").
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

async function commit(opts: WizardActions): Promise<void> {
  setBusy(opts.state, true);
  opts.requestUpdate();
  let committed = 0;
  let pullSummary: { projects: number; tasks: number; conflicts: number } | null = null;
  try {
    // Originally-selected DBs first.
    for (const dbId of opts.state.selectedDbIds) {
      const role = opts.state.roleByDb[dbId] ?? "custom";
      const fieldMap = opts.state.fieldMapByDb[dbId] ?? {};
      const conflictPolicy = opts.state.conflictPolicyByDb[dbId] ?? "queue";
      const applyPatch = opts.state.applyPatchByDb[dbId] === true;
      const title = opts.state.discovered.find((d) => d.id === dbId)?.title;
      const res = await rpc<{
        binding: unknown;
        initialPull: { projects: number; tasks: number; conflicts: number; skipped: boolean } | null;
      }>(opts.client, "notion.import.commit", {
        dbId,
        role,
        fieldMap,
        conflictPolicy,
        applyPatch,
        title,
      });
      committed++;
      // Last commit's pull summary wins — it ran the most recent backfill.
      if (res?.initialPull && !res.initialPull.skipped) {
        pullSummary = {
          projects: res.initialPull.projects,
          tasks: res.initialPull.tasks,
          conflicts: res.initialPull.conflicts,
        };
      }
    }
    // Auto-imported related DBs land as "custom" with the proposed identity
    // mapping so they show up in the bindings registry. Operator can refine
    // their role later via this wizard.
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
          conflictPolicy: "queue",
          applyPatch: false,
        });
        committed++;
      } catch {
        // Skip silently — the related-DB import is best-effort. The user
        // can re-run the wizard for this DB later.
      }
    }
    opts.state.commitSummary = { committed, pulled: pullSummary };
    opts.state.step = "commit";
  } catch (e: any) {
    opts.state.error = `Commit failed: ${e?.message ?? String(e)}`;
  } finally {
    setBusy(opts.state, false);
    opts.requestUpdate();
  }
}

function resetWizard(opts: WizardActions): void {
  Object.assign(opts.state, createNotionImportWizardState());
  opts.requestUpdate();
}

// ─────────────────────────────────────────────────────────────────────────
// Renders — one per step
// ─────────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<ImportRoleId, string> = {
  projects: "Projects",
  tasks: "Tasks",
  clients: "Clients",
  leads: "Leads",
  companies: "Companies",
  deals: "Deals",
  contacts: "Contacts",
  products: "Products",
  custom: "Custom (no role mapping)",
};

const ALL_ROLES: ImportRoleId[] = [
  "projects",
  "tasks",
  "clients",
  "leads",
  "companies",
  "deals",
  "contacts",
  "products",
  "custom",
];

function renderStepNav(state: NotionImportWizardState): TemplateResult {
  const steps: { id: WizardStep; label: string }[] = [
    { id: "connect", label: "1. Connect" },
    { id: "discover", label: "2. Discover" },
    { id: "roles", label: "3. Roles" },
    { id: "mapping", label: "4. Map fields" },
    { id: "relations", label: "5. Relations" },
    { id: "commit", label: "6. Done" },
  ];
  return html`
    <nav class="niw-steps">
      ${steps.map((s) => html`
        <span class=${`niw-step ${state.step === s.id ? "active" : ""}`}>${s.label}</span>
      `)}
    </nav>
  `;
}

function renderConnect(opts: WizardActions): TemplateResult {
  // We only land on Connect now as a recovery path when discover fails
  // with NOT_CONFIGURED / NOTION_AUTH_FAILED. No auto-detect spinner — the
  // wizard tried and the gateway said it needs a key.
  const skipToDiscover = () => {
    // Bypass verify entirely: the user might have just updated the env var
    // or fixed the file-stored key out-of-band. Jump back to Discover and
    // let listDatabases be the real test of whether the key works.
    opts.state.busy = false;
    opts.state.error = null;
    opts.state.tokenVerified = true;
    opts.state.step = "discover";
    opts.requestUpdate();
    void loadDiscovery(opts);
  };
  return html`
    <div class="niw-step-body">
      <h3>Connect Notion</h3>
      <p class="niw-muted">
        Paste your Notion integration token. Create one at
        <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a>,
        then share the parent page with the integration so we can see your databases.
      </p>
      <input
        class="niw-input"
        type="password"
        placeholder="secret_… or ntn_…"
        .value=${opts.state.apiKey}
        @input=${(e: Event) => { opts.state.apiKey = (e.target as HTMLInputElement).value; }}
      />
      <div class="niw-actions">
        <button class="niw-btn niw-btn-primary" ?disabled=${opts.state.busy} @click=${() => void verifyToken(opts)}>
          ${opts.state.busy ? "Verifying…" : "Verify and continue →"}
        </button>
        <button class="niw-btn" type="button"
          title="Skip the /users/me probe and try listing databases with whatever key the gateway already has."
          @click=${skipToDiscover}>
          Skip — use existing gateway key
        </button>
      </div>
    </div>
  `;
}

function renderDiscover(opts: WizardActions): TemplateResult {
  // Kick discovery the first time Discover renders — matches the change-DB
  // modal's `openChangeNotionDbModal` → `loadDiscover` boot path. Idempotent
  // via initChecked so re-renders don't spam the gateway.
  if (!opts.state.initChecked) {
    void checkExistingConnection(opts);
  }
  const dbs = opts.state.discovered;
  if (opts.state.busy && dbs.length === 0) {
    return html`
      <div class="niw-step-body">
        <h3>Pick databases to import</h3>
        <div class="niw-loading"><span class="niw-spinner"></span><span class="niw-muted">Scanning Notion…</span></div>
      </div>
    `;
  }
  const addManualDb = async () => {
    const id = extractNotionDbId(opts.state.manualDbInput);
    if (!id) {
      opts.state.error = "Couldn't find a Notion database ID in that input. Paste the full database URL or its 32-character id.";
      opts.requestUpdate();
      return;
    }
    opts.state.error = null;
    opts.state.busy = true;
    opts.requestUpdate();
    try {
      // Probe via the dedicated RPC so we get an actionable error if the
      // integration can't read this database. listDatabases would silently
      // drop a 403/404 and leave the user staring at an empty list.
      const res = await rpc<{ database: DiscoveredDb }>(
        opts.client,
        "notion.import.probeDatabase",
        { dbId: id },
      );
      const db = res.database;
      // Treat the probed DB as a normal Discover row.
      if (!opts.state.discovered.some((d) => d.id === db.id)) {
        opts.state.discovered = [...opts.state.discovered, db];
      }
      if (!opts.state.manualDbIds.includes(id)) {
        opts.state.manualDbIds = [...opts.state.manualDbIds, id];
      }
      opts.state.roleByDb[db.id] = db.existingBinding?.role ?? db.suggestedRole ?? "custom";
      opts.state.conflictPolicyByDb[db.id] = db.existingBinding?.conflictPolicy ?? "queue";
      opts.state.selectedDbIds.add(db.id);
      opts.state.manualDbInput = "";
    } catch (e: any) {
      const code = e?.code ?? e?.cause?.code ?? "";
      const msg = e?.message ?? String(e);
      opts.state.error = code === "NOTION_FORBIDDEN" || /restricted_resource|insufficient_permission/i.test(msg)
        ? msg
        : code === "NOTION_NOT_FOUND" || /object_not_found|couldn't find/i.test(msg)
          ? msg
          : `Couldn't probe that database: ${msg}`;
    } finally {
      opts.state.busy = false;
      opts.requestUpdate();
    }
  };
  return html`
    <div class="niw-step-body">
      <h3>Pick databases to import</h3>
      <p class="niw-muted">
        Showing ${dbs.length} database${dbs.length === 1 ? "" : "s"} the integration can read.
        Already-bound databases are flagged so you can re-import or just refine their mapping.
      </p>

      <div class="niw-manual-add" style="display:flex; gap:8px; margin: 12px 0; padding: 10px 12px; border: 1px dashed color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px;">
        <input
          class="niw-input"
          type="text"
          style="flex: 1;"
          placeholder="Paste a Notion database URL or ID to add it manually…"
          .value=${opts.state.manualDbInput}
          @input=${(e: Event) => { opts.state.manualDbInput = (e.target as HTMLInputElement).value; opts.requestUpdate(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") addManualDb(); }}
        />
        <button class="niw-btn" type="button"
          ?disabled=${opts.state.busy || !opts.state.manualDbInput.trim()}
          @click=${() => void addManualDb()}
          title="Probe /databases/{id} for this Notion DB and add it to the list if the integration can read it.">
          ${opts.state.busy ? "Probing…" : "+ Add by URL/ID"}
        </button>
      </div>
      ${opts.state.manualDbIds.length > 0
        ? html`<div style="display:flex; align-items:center; gap:8px; font-size:11px; color: rgba(255,255,255,0.6); margin: 4px 0;">
            <span>Manually-added probe set: ${opts.state.manualDbIds.length} id${opts.state.manualDbIds.length === 1 ? "" : "s"}</span>
            <button class="niw-btn" type="button"
              style="padding: 2px 8px; font-size: 10px;"
              ?disabled=${opts.state.busy}
              @click=${async () => {
                // Re-probe each manual id via the dedicated probe RPC so
                // we surface the actual Notion error (403/404/etc) instead
                // of the silent listDatabases drop.
                const ids = opts.state.manualDbIds.slice();
                opts.state.busy = true;
                opts.state.error = null;
                opts.requestUpdate();
                let lastError: string | null = null;
                let added = 0;
                for (const id of ids) {
                  try {
                    const res = await rpc<{ database: DiscoveredDb }>(
                      opts.client,
                      "notion.import.probeDatabase",
                      { dbId: id },
                    );
                    const db = res.database;
                    if (!opts.state.discovered.some((d) => d.id === db.id)) {
                      opts.state.discovered = [...opts.state.discovered, db];
                      added++;
                    }
                    opts.state.roleByDb[db.id] = db.existingBinding?.role ?? db.suggestedRole ?? "custom";
                    opts.state.conflictPolicyByDb[db.id] = db.existingBinding?.conflictPolicy ?? "queue";
                  } catch (e: any) {
                    lastError = `${id.slice(0, 8)}…: ${e?.message ?? String(e)}`;
                  }
                }
                opts.state.busy = false;
                if (lastError && added === 0) opts.state.error = lastError;
                opts.requestUpdate();
              }}>↻ Re-probe</button>
            <button class="niw-btn" type="button"
              style="padding: 2px 8px; font-size: 10px;"
              @click=${() => { opts.state.manualDbIds = []; opts.state.error = null; opts.requestUpdate(); }}>
              Clear
            </button>
          </div>`
        : nothing}

      ${dbs.length === 0
        ? html`<p class="niw-empty">No databases visible. Did you share a page with the integration? Or paste a database URL above to import it directly.</p>`
        : html`
            <table class="niw-table">
              <thead>
                <tr><th></th><th>Database</th><th>Properties</th><th>Suggested role</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${dbs.map((db) => html`
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        .checked=${opts.state.selectedDbIds.has(db.id)}
                        @change=${() => toggleSelected(opts, db.id)}
                      />
                    </td>
                    <td>
                      <strong>${db.title}</strong>
                      ${db.url ? html`<br /><a class="niw-link" href=${db.url} target="_blank">open</a>` : nothing}
                    </td>
                    <td>${db.propertyCount}</td>
                    <td><code>${ROLE_LABEL[db.suggestedRole]}</code></td>
                    <td>
                      ${db.existingBinding
                        ? html`<span class="niw-pill niw-pill-warn">Already bound (${db.existingBinding.role})</span>`
                        : db.isSystemManaged
                          ? html`<span class="niw-pill niw-pill-info">System DB</span>`
                          : html`<span class="niw-pill">New</span>`}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
      <div class="niw-actions">
        <button class="niw-btn" @click=${() => { opts.state.step = "connect"; opts.requestUpdate(); }}>← Back</button>
        <button class="niw-btn niw-btn-primary" ?disabled=${opts.state.busy} @click=${() => void goToRoles(opts)}>
          Next: assign roles →
        </button>
      </div>
    </div>
  `;
}

function renderRoles(opts: WizardActions): TemplateResult {
  const selected = opts.state.discovered.filter((db) => opts.state.selectedDbIds.has(db.id));
  return html`
    <div class="niw-step-body">
      <h3>Assign a role per database</h3>
      <p class="niw-muted">
        The role tells InfiniBot how to interpret each DB. Pick "Custom" if none of the canonical
        shapes fits — InfiniBot will still sync the DB but won't try to map fields semantically.
      </p>
      <table class="niw-table">
        <thead>
          <tr><th>Database</th><th>Role</th><th>Conflict policy</th></tr>
        </thead>
        <tbody>
          ${selected.map((db) => html`
            <tr>
              <td><strong>${db.title}</strong></td>
              <td>
                <select
                  class="niw-select"
                  .value=${opts.state.roleByDb[db.id] ?? db.suggestedRole}
                  @change=${(e: Event) => {
                    opts.state.roleByDb[db.id] = (e.target as HTMLSelectElement).value as ImportRoleId;
                    opts.requestUpdate();
                  }}
                >
                  ${ALL_ROLES.map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}
                </select>
              </td>
              <td>
                <select
                  class="niw-select"
                  .value=${opts.state.conflictPolicyByDb[db.id] ?? "queue"}
                  @change=${(e: Event) => {
                    opts.state.conflictPolicyByDb[db.id] = (e.target as HTMLSelectElement).value as
                      | "queue"
                      | "last-write-wins";
                    opts.requestUpdate();
                  }}
                >
                  <option value="queue">Queue conflicts (recommended)</option>
                  <option value="last-write-wins">Last write wins</option>
                </select>
              </td>
            </tr>
          `)}
        </tbody>
      </table>
      <div class="niw-actions">
        <button class="niw-btn" @click=${() => { opts.state.step = "discover"; opts.requestUpdate(); }}>← Back</button>
        <button class="niw-btn niw-btn-primary" ?disabled=${opts.state.busy} @click=${() => void goToMapping(opts)}>
          Next: map fields →
        </button>
      </div>
    </div>
  `;
}

function renderMappingForDb(opts: WizardActions, dbId: string): TemplateResult {
  const db = opts.state.discovered.find((d) => d.id === dbId);
  const preview = opts.state.previewByDb[dbId];
  const role = opts.state.roleByDb[dbId] ?? "custom";
  if (!preview || !db) return html`<div class="niw-card niw-muted">Loading ${db?.title ?? dbId}…</div>`;

  const map = opts.state.fieldMapByDb[dbId] ?? {};
  const propNames = preview.propertyNames;

  // Rows = canonical fields when role is known; otherwise = every Notion property.
  const rows =
    role === "custom"
      ? propNames.map((name) => ({ canonical: name, currentMapped: name, isCustom: true }))
      : (preview.diff?.diffs ?? []).map((d) => ({
          canonical: d.canonical,
          currentMapped: map[d.canonical] ?? d.existingAlias ?? "",
          isCustom: false,
          missing: d.missing,
          typeMismatch: d.typeMismatch,
          actualType: d.actualType,
          expectedType: d.type,
        }));

  return html`
    <div class="niw-card">
      <div class="niw-card-head">
        <strong>${db.title}</strong> <code class="niw-mono">${dbId.slice(0, 8)}…</code>
        <span class="niw-pill">${ROLE_LABEL[role]}</span>
        <div class="niw-spacer"></div>
        ${role !== "custom"
          ? html`<label class="niw-check">
              <input
                type="checkbox"
                .checked=${opts.state.applyPatchByDb[dbId] === true}
                @change=${(e: Event) => {
                  opts.state.applyPatchByDb[dbId] = (e.target as HTMLInputElement).checked;
                  opts.requestUpdate();
                }}
              />
              Add missing properties to Notion on commit
            </label>`
          : nothing}
      </div>
      <table class="niw-table">
        <thead>
          <tr>
            <th>InfiniBot field</th>
            <th>Notion property</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row: any) => html`
            <tr>
              <td><code>${row.canonical}</code></td>
              <td>
                <select
                  class="niw-select"
                  .value=${map[row.canonical] ?? ""}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    if (v === "") delete map[row.canonical];
                    else map[row.canonical] = v;
                    opts.state.fieldMapByDb[dbId] = { ...map };
                    opts.requestUpdate();
                  }}
                >
                  <option value="">— ignore —</option>
                  ${propNames.map((n) => html`<option value=${n}>${n}</option>`)}
                </select>
              </td>
              <td>
                ${row.isCustom
                  ? html`<span class="niw-pill">passthrough</span>`
                  : row.missing
                    ? html`<span class="niw-pill niw-pill-warn">Missing in Notion</span>`
                    : row.typeMismatch
                      ? html`<span class="niw-pill niw-pill-err">Type mismatch (${row.actualType ?? "?"} vs ${row.expectedType})</span>`
                      : html`<span class="niw-pill niw-pill-ok">OK</span>`}
              </td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function renderMapping(opts: WizardActions): TemplateResult {
  const ids = Array.from(opts.state.selectedDbIds);
  return html`
    <div class="niw-step-body">
      <h3>Map fields per database</h3>
      <p class="niw-muted">
        Adjust which Notion property feeds each InfiniBot field. Type mismatches need to be fixed
        manually in Notion — InfiniBot won't change a property's type for you.
      </p>
      ${ids.map((id) => renderMappingForDb(opts, id))}
      <div class="niw-actions">
        <button class="niw-btn" @click=${() => { opts.state.step = "roles"; opts.requestUpdate(); }}>← Back</button>
        <button class="niw-btn niw-btn-primary" ?disabled=${opts.state.busy} @click=${() => void goToRelations(opts)}>
          Next: scan relations →
        </button>
      </div>
    </div>
  `;
}

function renderRelations(opts: WizardActions): TemplateResult {
  const grouped: Record<string, RelationLink[]> = {};
  for (const r of opts.state.relations) {
    if (!grouped[r.targetDbId]) grouped[r.targetDbId] = [];
    grouped[r.targetDbId].push(r);
  }
  const targets = Object.entries(grouped);
  return html`
    <div class="niw-step-body">
      <h3>Cross-database relations</h3>
      ${targets.length === 0
        ? html`<p class="niw-empty">No relation columns to resolve. Continue to commit.</p>`
        : html`
            <p class="niw-muted">
              The DBs you selected reference these other databases. Auto-importing them keeps relation
              columns resolvable on both sides; skipping leaves them as opaque page IDs.
            </p>
            ${targets.map(([targetDbId, links]) => {
              const known = links[0]?.targetIsKnown;
              return html`
                <div class="niw-card">
                  <div class="niw-card-head">
                    <strong>${links[0]?.targetTitle ?? "Untitled"}</strong>
                    <code class="niw-mono">${targetDbId.slice(0, 8)}…</code>
                    ${known ? html`<span class="niw-pill niw-pill-ok">Already imported / selected</span>` : nothing}
                  </div>
                  <ul class="niw-list">
                    ${links.map((l) => {
                      const src = opts.state.discovered.find((d) => d.id === l.sourceDbId);
                      return html`<li><code>${src?.title ?? "?"}</code>.<code>${l.sourceProp}</code> → this</li>`;
                    })}
                  </ul>
                  ${!known
                    ? html`<label class="niw-check">
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
      <div class="niw-actions">
        <button class="niw-btn" @click=${() => { opts.state.step = "mapping"; opts.requestUpdate(); }}>← Back</button>
        <button class="niw-btn niw-btn-primary" ?disabled=${opts.state.busy} @click=${() => void commit(opts)}>
          ${opts.state.busy ? "Committing…" : "Commit and run initial sync →"}
        </button>
      </div>
    </div>
  `;
}

function renderCommit(opts: WizardActions): TemplateResult {
  const s = opts.state.commitSummary;
  return html`
    <div class="niw-step-body">
      <h3>All set</h3>
      <p>
        Imported <strong>${s?.committed ?? 0}</strong> database${s?.committed === 1 ? "" : "s"}.
        ${s?.pulled
          ? html`Initial pull: <strong>${s.pulled.projects}</strong> projects,
              <strong>${s.pulled.tasks}</strong> tasks${s.pulled.conflicts > 0
                ? html`, <strong>${s.pulled.conflicts}</strong> conflicts queued for review`
                : nothing}.`
          : nothing}
      </p>
      <p class="niw-muted">
        The bidirectional poller will keep these databases in sync from here. Conflicts (if any) live
        in the conflicts panel — resolve them field-by-field whenever you have a moment.
      </p>
      <div class="niw-actions">
        <button class="niw-btn niw-btn-primary" @click=${() => resetWizard(opts)}>Import more</button>
      </div>
    </div>
  `;
}

export function renderNotionImportWizard(opts: WizardActions): TemplateResult {
  injectStyles();
  return html`
    ${g8GlassStyles}
    <section class="niw g8-page">
      <header class="niw-header">
        <span class="niw-title">Notion import</span>
        ${opts.state.tokenVerified
          ? html`<span class="niw-muted">Connected to ${opts.state.workspace ?? opts.state.integrationName ?? "Notion"}</span>`
          : nothing}
      </header>
      ${renderStepNav(opts.state)}
      ${opts.state.error ? html`<div class="niw-error">${opts.state.error}</div>` : nothing}
      ${(() => {
        switch (opts.state.step) {
          case "connect": return renderConnect(opts);
          case "discover": return renderDiscover(opts);
          case "roles": return renderRoles(opts);
          case "mapping": return renderMapping(opts);
          case "relations": return renderRelations(opts);
          case "commit": return renderCommit(opts);
        }
      })()}
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
  style.id = "infinibot-notion-import-wizard-styles";
  style.textContent = NIW_STYLES;
  document.head.appendChild(style);
}

const NIW_STYLES = `
.niw {
  border: 1px solid rgba(250, 204, 21, 0.16);
  background: linear-gradient(180deg, rgba(250, 204, 21, 0.04), rgba(0, 0, 0, 0.18));
  border-radius: 12px;
  padding: 16px;
  color: var(--c-fg, #f5f5f4);
  font-size: 13px;
}
.niw-header { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 12px; }
.niw-title { font-weight: 600; font-size: 14px; }
.niw-muted { opacity: 0.7; font-size: 12px; }
.niw-empty { padding: 16px; text-align: center; opacity: 0.55; border: 1px dashed rgba(255,255,255,0.08); border-radius: 6px; }
.niw-error { color: #ef5b5b; font-size: 12px; padding: 6px 8px; background: rgba(239, 91, 91, 0.08); border-radius: 4px; margin-bottom: 8px; }
.niw-steps { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.niw-step { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); opacity: 0.55; }
.niw-step.active { opacity: 1; color: #ffc861; border-color: rgba(245, 181, 66, 0.4); background: rgba(245, 181, 66, 0.08); }
.niw-step-body h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.niw-step-body p { margin: 4px 0 12px; }
.niw-input { width: 100%; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; background: rgba(0,0,0,0.3); color: inherit; font: inherit; margin-bottom: 12px; }
.niw-input:focus { outline: none; border-color: rgba(245, 181, 66, 0.5); }
.niw-select { padding: 4px 8px; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; background: rgba(0,0,0,0.3); color: inherit; font: inherit; font-size: 12px; }
.niw-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
.niw-btn { font: inherit; cursor: pointer; padding: 6px 14px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.04); color: inherit; }
.niw-btn:disabled { opacity: 0.5; cursor: progress; }
.niw-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
.niw-btn-primary { border-color: rgba(245, 181, 66, 0.5); background: rgba(245, 181, 66, 0.12); color: #ffc861; }
.niw-btn-primary:hover:not(:disabled) { background: rgba(245, 181, 66, 0.22); }
.niw-table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; }
.niw-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #71717a; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
.niw-table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; }
.niw-pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.06); color: #a3a3ad; }
.niw-pill-ok { color: #5fd17a; background: rgba(95, 209, 122, 0.08); }
.niw-pill-warn { color: #f5b542; background: rgba(245, 181, 66, 0.08); }
.niw-pill-err { color: #ef5b5b; background: rgba(239, 91, 91, 0.08); }
.niw-pill-info { color: #6ea7ff; background: rgba(110, 167, 255, 0.08); }
.niw-mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; opacity: 0.55; }
.niw-card { padding: 10px 12px; margin: 8px 0; background: rgba(0,0,0,0.18); border-radius: 8px; border: 1px solid rgba(255,255,255,0.04); }
.niw-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.niw-spacer { flex: 1; }
.niw-check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.niw-check input { cursor: pointer; }
.niw-link { color: #6ea7ff; text-decoration: none; font-size: 11px; }
.niw-link:hover { text-decoration: underline; }
.niw-list { margin: 4px 0; padding-left: 22px; font-size: 12px; }
.niw-list code { padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.06); font-size: 11px; }
.niw-loading { display: flex; align-items: center; justify-content: center; padding: 24px; }
.niw-spinner { width: 22px; height: 22px; border: 2px solid rgba(255,255,255,0.12); border-top-color: var(--g-primary, #fbbf24); border-radius: 50%; animation: niw-spin 0.8s linear infinite; }
@keyframes niw-spin { to { transform: rotate(360deg); } }
`;

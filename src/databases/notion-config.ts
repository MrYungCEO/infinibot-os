/**
 * Centralized Notion configuration.
 *
 * Every caller that talks to Notion must go through this module — it is the
 * single contract for "is Notion configured?". Callers should never throw on
 * missing config; they should fall back to local SQLite. The kanban system
 * therefore works for users with no Notion at all.
 *
 * Configuration sources, in priority order:
 *   1. In-memory runtime override (set by the wizard after a successful verify)
 *   2. The `notion` block in infinibot.json (apiKey, syncMode, projectsDbId,
 *      tasksDbId, parentPageId, integrationName)
 *   3. The legacy `NOTION_API_KEY` env var (treated as `mirror` mode)
 */
import type { DatabasesStore } from "./store.js";
import { loadConfig as loadAppConfig } from "../config/io.js";

export type NotionSyncMode =
  /** No Notion sync at all. Local SQLite is the only source. */
  | "off"
  /** Local SQLite is the source of truth; changes are mirrored to Notion. */
  | "mirror"
  /** One-shot import from Notion into local SQLite. After import, mode flips to "off". */
  | "import-once";

/**
 * Canonical role ids the bindings registry recognizes. Mirrors the
 * roles in `notion-schema.ts` plus `custom` for imported DBs that don't
 * fit any canonical shape (we still want them in the registry so the
 * poller, conflict queue, and UI can iterate "every connected DB" via
 * one source of truth).
 */
export type NotionRoleId =
  | "projects"
  | "tasks"
  | "clients"
  | "leads"
  | "companies"
  | "deals"
  | "contacts"
  | "products"
  | "custom";

/** How drift between local + Notion is resolved on overlap. */
export type ConflictPolicy = "queue" | "last-write-wins";

/**
 * One row of the bindings registry. Key in NotionConfig.bindings is the
 * Notion DB id (no dashes? we keep whatever Notion returned — readers
 * normalize via stripDashes when comparing).
 *
 * fieldMap is the source of truth for "InfiniBot field X lives in Notion
 * property Y". Kept by NAME, not by Notion property id, because users
 * routinely rename properties and we want the binding to follow.
 */
export interface NotionBinding {
  notionDbId: string;
  role: NotionRoleId;
  /** InfiniBot canonical field name → Notion property name. */
  fieldMap: Record<string, string>;
  /** For role="custom": properties that don't map to any canonical field. */
  customFields?: Record<string, { name: string; type: string }>;
  lastSyncedAt: number | null;
  conflictPolicy: ConflictPolicy;
  /** Cached display title for the UI. Refreshed by the poller when set. */
  title?: string | null;
  /**
   * Per-business scope for roles whose rows live in a dedicated database
   * per business (products, clients, leads). Set by the import wizard
   * when the operator initiates the import from a business-scoped page.
   * Null/absent = the binding feeds the global role mapping.
   */
  businessId?: string | null;
}

export interface NotionConfig {
  apiKey: string | null;
  syncMode: NotionSyncMode;
  /** Notion database id used as the canonical Projects DB for kanban sync. */
  projectsDbId: string | null;
  /** Notion database id used as the canonical Tasks DB for kanban sync. */
  tasksDbId: string | null;
  /** Parent page id under which we created the system DBs (used for re-verification). */
  parentPageId: string | null;
  /** Display name of the connected Notion integration ("InfiniBot Sync" etc.). */
  integrationName: string | null;
  /** Notion database ids for the InfiniBot CRM system, created during onboarding. */
  clientsDbId: string | null;
  leadsDbId: string | null;
  companiesDbId: string | null;
  dealsDbId: string | null;
  contactsDbId: string | null;
  /** Optional database used by the income-entry Notion mirror. */
  incomeStreamsDbId: string | null;
  /**
   * Unified registry of every Notion DB this install talks to, indexed by
   * Notion DB id. The bidirectional poller, conflict queue, schema
   * reconciler, and the unified import wizard all read from here. New
   * bindings are written by the import wizard or synthesized on read from
   * the legacy projectsDbId/tasksDbId/CRM ids so existing installs keep
   * working without a migration step.
   */
  bindings: Record<string, NotionBinding>;
}

const DEFAULT_CONFIG: NotionConfig = {
  apiKey: null,
  syncMode: "off",
  projectsDbId: null,
  tasksDbId: null,
  parentPageId: null,
  integrationName: null,
  clientsDbId: null,
  leadsDbId: null,
  companiesDbId: null,
  dealsDbId: null,
  contactsDbId: null,
  incomeStreamsDbId: null,
  bindings: {},
};

let runtimeOverride: Partial<NotionConfig> | null = null;

/** Read fresh config every call so wizard updates land without a restart. */
export function getNotionConfig(): NotionConfig {
  const fromConfigFile = readFromConfigFile();
  const fromEnv = readFromEnv();
  const merged: NotionConfig = {
    ...DEFAULT_CONFIG,
    ...fromEnv,
    ...fromConfigFile,
    ...runtimeOverride,
  };
  // Bindings need a deeper merge — spread above replaces the whole map.
  merged.bindings = {
    ...fromConfigFile.bindings,
    ...runtimeOverride?.bindings,
  };

  // Env-only fallback: if a key is present but no explicit syncMode was set,
  // treat the env var as a mirror request — preserves old user setups.
  if (
    merged.apiKey &&
    merged.syncMode === "off" &&
    !fromConfigFile.syncMode &&
    runtimeOverride?.syncMode === undefined
  ) {
    merged.syncMode = "mirror";
  }

  // Legacy synthesis: pre-bindings configs only have projectsDbId/tasksDbId
  // and the five CRM ids. Synthesize one binding per id so every reader
  // (poller, conflict queue, UI) sees a uniform shape. The synthesized
  // bindings stay in-memory only until something writes to disk —
  // writeNotionConfig persists them so subsequent loads skip this step.
  synthesizeLegacyBindings(merged);

  return merged;
}

export function isNotionEnabled(): boolean {
  const cfg = getNotionConfig();
  return cfg.syncMode !== "off" && !!cfg.apiKey;
}

/**
 * Trim wrapping whitespace + zero-width junk and reject non-Latin-1
 * characters that would crash fetch() with a ByteString TypeError when
 * fed into the Authorization header. Returns null if the input is empty
 * or unsanitizable. Pasted Notion keys routinely carry hitchhikers from
 * the source (tooltip ellipsis, smart quotes, NBSP, BOM); rather than
 * fail mid-request we either fix it here or refuse the key cleanly.
 */
function sanitizeApiKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/^[\s​‌‍﻿]+|[\s​‌‍﻿]+$/g, "");
  if (!trimmed) return null;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) > 255) return null;
  }
  return trimmed;
}

export function getNotionApiKeyOrNull(): string | null {
  const cfg = getNotionConfig();
  if (!isNotionEnabled()) return null;
  return sanitizeApiKey(cfg.apiKey);
}

/**
 * Like `getNotionApiKeyOrNull` but does not require background sync to be
 * enabled — returns the key as long as one is configured. Import is an
 * explicit, scoped operation the user is initiating right now; gating it
 * on `syncMode !== "off"` meant `business.notion.databases` (raw env-var
 * read) showed the user their databases while `notion.import.listDatabases`
 * claimed Notion was "not configured" — same key, different gates.
 *
 * Env var wins over the file-stored key here: `business.notion.databases`
 * reads `process.env.NOTION_API_KEY` directly with no merge, so the user's
 * Notion picker on the Business page is always using the env-var
 * integration. If the file-stored key (set during initial wizard setup)
 * points at a different integration with less DB access, the import flows
 * would show 0 databases while the business picker showed plenty — same
 * Notion workspace, two integrations, two views of "your" databases.
 * Aligning the import path with the env var fixes that asymmetry; the
 * file-stored key falls back through when no env var is set.
 */
export function getNotionApiKeyForImport(): string | null {
  const envKey = sanitizeApiKey(process.env.NOTION_API_KEY);
  if (envKey) return envKey;
  const cfg = getNotionConfig();
  return sanitizeApiKey(cfg.apiKey);
}

/**
 * Set an in-memory override for the current process — used by the wizard so
 * the user can verify their key without writing it to disk first.
 */
export function setNotionRuntimeOverride(patch: Partial<NotionConfig> | null): void {
  runtimeOverride = patch;
}

/**
 * Persist Notion config into infinibot.json. Used by the wizard after
 * verification + system DB creation succeed. Existing keys are preserved
 * unless explicitly overwritten in `patch`.
 */
export async function writeNotionConfig(patch: Partial<NotionConfig>): Promise<NotionConfig> {
  // Lazy-loaded to avoid pulling the config IO chain into modules that just
  // want to read sync mode. The config IO module also lazy-loads when it
  // needs to write, so this stays cheap on the read path.
  const { writeConfigFile, readConfigFileSnapshot } = await import("../config/io.js");
  // Use the raw on-disk parse, NOT loadConfig(). loadConfig returns {} on any
  // strict-validation or env-substitution failure, so writing back loses every
  // top-level block (channels, models, agents, …). The wizard's Notion step
  // would then leave the file containing only `{ notion: … }` + meta, which in
  // turn makes the next quickstart re-run start from a hollowed-out config.
  // readConfigFileSnapshot().parsed survives validation failure.
  const snapshot = await readConfigFileSnapshot();
  const parsed = snapshot.parsed;
  const current: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  const existingNotion = (current.notion as Partial<NotionConfig>) ?? {};
  const next: Partial<NotionConfig> = {
    ...existingNotion,
    ...patch,
  };
  // Drop nullish keys so we don't litter the JSON with `null` placeholders.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v !== null && v !== undefined && v !== "") cleaned[k] = v;
  }
  current.notion = cleaned;

  // Defensive: backfill any stale `models.providers.X` entries that an
  // earlier wizard step left without a `models: []` array. Without this,
  // `writeConfigFile`'s strict validator would reject the whole file —
  // including the Notion block we're trying to save — and the user would
  // see the Notion step "loop" while their config got rolled back.
  // `quickstart.applyPatch` does the same before its writes; sharing the
  // helper keeps the two paths in lockstep.
  const { sanitizeMergedConfig } = await import("../config/sanitize.js");
  sanitizeMergedConfig(current);

  await writeConfigFile(current as never);
  setNotionRuntimeOverride(null);

  // If this process is a federation master, immediately push the refreshed
  // Notion block to every satellite so they don't have to re-run the wizard
  // (or wait for reconnect) to learn the new DB ids + API key.
  // Fire-and-forget — failures here must not block the wizard from finishing.
  try {
    const { getFederationHub } = await import("../federation/index.js");
    const hub = getFederationHub();
    if (hub && typeof hub.pushIdentityToAll === "function") {
      hub.pushIdentityToAll().catch(() => {
        // Logged inside the manager — swallow here to keep the wizard path quiet.
      });
    }
  } catch {
    // Federation module not loaded (e.g. running outside the gateway process). Harmless.
  }

  return getNotionConfig();
}

// ─────────────────────────────────────────────────────────────────────────
// Bindings registry — public helpers
// ─────────────────────────────────────────────────────────────────────────

/** Return the binding for a Notion DB id, or null if none is registered. */
export function getBinding(notionDbId: string): NotionBinding | null {
  if (!notionDbId) return null;
  const cfg = getNotionConfig();
  // Try exact match first; fall back to normalized comparison so callers
  // can pass either dashed or undashed forms.
  const direct = cfg.bindings[notionDbId];
  if (direct) return direct;
  const normalized = stripDashes(notionDbId);
  for (const [k, v] of Object.entries(cfg.bindings)) {
    if (stripDashes(k) === normalized) return v;
  }
  return null;
}

/** Return every binding for a given role (e.g. all "tasks" DBs). */
export function getBindingsByRole(role: NotionRoleId): NotionBinding[] {
  const cfg = getNotionConfig();
  return Object.values(cfg.bindings).filter((b) => b.role === role);
}

/** Return every binding regardless of role — used by the poller. */
export function getAllBindings(): NotionBinding[] {
  const cfg = getNotionConfig();
  return Object.values(cfg.bindings);
}

/**
 * Persist a binding (insert or update). Merges with the existing binding
 * for the same DB id if one exists, so callers can patch individual fields
 * (e.g. just bump lastSyncedAt) without re-stating the field map.
 */
export async function upsertBinding(binding: NotionBinding): Promise<NotionConfig> {
  const cfg = getNotionConfig();
  const existing = cfg.bindings[binding.notionDbId];
  const merged: NotionBinding = existing
    ? {
        ...existing,
        ...binding,
        fieldMap: { ...existing.fieldMap, ...binding.fieldMap },
      }
    : binding;
  const next = { ...cfg.bindings, [binding.notionDbId]: merged };
  return writeNotionConfig({ bindings: next });
}

/** Remove a binding entirely. The Notion DB itself is left alone. */
export async function removeBinding(notionDbId: string): Promise<NotionConfig> {
  const cfg = getNotionConfig();
  if (!cfg.bindings[notionDbId]) {
    // Not present under exact key — try normalized lookup so a caller using
    // a differently-formatted id (with/without dashes) still removes it.
    const normalized = stripDashes(notionDbId);
    const realKey = Object.keys(cfg.bindings).find((k) => stripDashes(k) === normalized);
    if (!realKey) return cfg;
    notionDbId = realKey;
  }
  const next = { ...cfg.bindings };
  delete next[notionDbId];
  return writeNotionConfig({ bindings: next });
}

function stripDashes(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * Default field map for each canonical role. The values are the canonical
 * Notion property names the wizard creates — for a wizard-managed DB the
 * map is identity. For an imported DB whose property names diverge, the
 * import wizard rewrites this mapping per-binding before saving.
 *
 * Kept in this module (not imported from notion-schema.ts) so the migration
 * path doesn't pull the schema module's network/cache dependencies into
 * the config read hot path.
 */
const DEFAULT_FIELD_MAP_BY_ROLE: Record<Exclude<NotionRoleId, "custom">, Record<string, string>> = {
  projects: {
    Project: "Project",
    Status: "Status",
    Priority: "Priority",
    Description: "Description",
    "Due Date": "Due Date",
  },
  tasks: {
    "Task Name": "Task Name",
    "Status Update": "Status Update",
    "Priority Level": "Priority Level",
    Description: "Description",
    "Due Date": "Due Date",
    Done: "Done",
    Project: "Project",
  },
  clients: { Name: "Name", Email: "Email", Phone: "Phone", Status: "Status", Notes: "Notes" },
  leads: { Name: "Name", Source: "Source", Stage: "Stage", Email: "Email", Notes: "Notes" },
  companies: { Name: "Name", Industry: "Industry", Website: "Domain", Notes: "Notes" },
  deals: { Name: "Name", Stage: "Stage", Amount: "Amount", "Close Date": "Close Date" },
  contacts: { Name: "Name", Email: "Email", Phone: "Phone", Role: "Title" },
  products: {
    Name: "Name",
    SKU: "SKU",
    Type: "Type",
    Status: "Status",
    Price: "Price",
    Inventory: "Inventory",
    Category: "Category",
    Description: "Description",
    Image: "Image",
    Tags: "Tags",
  },
};

function makeSyntheticBinding(role: NotionRoleId, dbId: string): NotionBinding {
  const fieldMap = role === "custom" ? {} : { ...DEFAULT_FIELD_MAP_BY_ROLE[role] };
  return {
    notionDbId: dbId,
    role,
    fieldMap,
    lastSyncedAt: null,
    conflictPolicy: "queue",
  };
}

/**
 * If the loaded config has the legacy projectsDbId/tasksDbId/CRM ids but
 * no matching binding entry, synthesize one in-memory. This lets pre-
 * bindings installs flow through the new code paths without forcing a
 * write. Mutates `cfg.bindings` in place.
 */
function synthesizeLegacyBindings(cfg: NotionConfig): void {
  const ensure = (role: NotionRoleId, dbId: string | null) => {
    if (!dbId) return;
    if (cfg.bindings[dbId]) return;
    // Also skip if a normalized-id duplicate already exists (avoids two
    // entries for the same DB when one form has dashes and one doesn't).
    const normalized = stripDashes(dbId);
    if (Object.keys(cfg.bindings).some((k) => stripDashes(k) === normalized)) return;
    cfg.bindings[dbId] = makeSyntheticBinding(role, dbId);
  };
  ensure("projects", cfg.projectsDbId);
  ensure("tasks", cfg.tasksDbId);
  ensure("clients", cfg.clientsDbId);
  ensure("leads", cfg.leadsDbId);
  ensure("companies", cfg.companiesDbId);
  ensure("deals", cfg.dealsDbId);
  ensure("contacts", cfg.contactsDbId);
}

function isRoleId(v: unknown): v is NotionRoleId {
  return (
    v === "projects" ||
    v === "tasks" ||
    v === "clients" ||
    v === "leads" ||
    v === "companies" ||
    v === "deals" ||
    v === "contacts" ||
    v === "products" ||
    v === "custom"
  );
}

function isConflictPolicy(v: unknown): v is ConflictPolicy {
  return v === "queue" || v === "last-write-wins";
}

function parseBindings(raw: unknown): Record<string, NotionBinding> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, NotionBinding> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const b = v as Record<string, unknown>;
    if (!isRoleId(b.role)) continue;
    const fieldMap: Record<string, string> = {};
    if (b.fieldMap && typeof b.fieldMap === "object" && !Array.isArray(b.fieldMap)) {
      for (const [fk, fv] of Object.entries(b.fieldMap as Record<string, unknown>)) {
        if (typeof fv === "string") fieldMap[fk] = fv;
      }
    }
    out[k] = {
      notionDbId: typeof b.notionDbId === "string" ? b.notionDbId : k,
      role: b.role,
      fieldMap,
      customFields:
        b.customFields && typeof b.customFields === "object" && !Array.isArray(b.customFields)
          ? (b.customFields as NotionBinding["customFields"])
          : undefined,
      lastSyncedAt: typeof b.lastSyncedAt === "number" ? b.lastSyncedAt : null,
      conflictPolicy: isConflictPolicy(b.conflictPolicy) ? b.conflictPolicy : "queue",
      title: typeof b.title === "string" ? b.title : null,
      // Preserve per-business scope on read. Without this every persisted
      // binding came back with businessId=undefined, so the products
      // applier (which keys per-business rows off this) had nowhere to
      // write and the products page stayed empty even after a "✓ imported"
      // log line.
      businessId: typeof b.businessId === "string" ? b.businessId : null,
    };
  }
  return out;
}

function readFromConfigFile(): Partial<NotionConfig> {
  // Reads the wizard-saved Notion block from infinibot.json on every call so
  // a wizard re-run during the gateway's lifetime is picked up immediately
  // (loadConfig has its own short-TTL cache). The earlier implementation used
  // CommonJS `require()` here to dodge a perceived import cycle — but this
  // package compiles to ESM (package.json "type": "module"), so `require` is
  // undefined at runtime and the try/catch silently swallowed every call,
  // turning getNotionConfig() into "always returns DEFAULT_CONFIG". That made
  // every reader (kanban-tool, kanban-store-ops, notion-sync, etc.) think
  // Notion was unconfigured and either skip or fall back to the legacy
  // hardcoded UUIDs that only the bot author's integration has access to.
  try {
    const cfg = (loadAppConfig() ?? {}) as Record<string, unknown>;
    const block = cfg.notion as Partial<NotionConfig> | undefined;
    if (!block) return {};
    const out: Partial<NotionConfig> = {};
    if (typeof block.apiKey === "string") out.apiKey = block.apiKey;
    if (isSyncMode(block.syncMode)) out.syncMode = block.syncMode;
    if (typeof block.projectsDbId === "string") out.projectsDbId = block.projectsDbId;
    if (typeof block.tasksDbId === "string") out.tasksDbId = block.tasksDbId;
    if (typeof block.parentPageId === "string") out.parentPageId = block.parentPageId;
    if (typeof block.integrationName === "string") out.integrationName = block.integrationName;
    if (typeof block.clientsDbId === "string") out.clientsDbId = block.clientsDbId;
    if (typeof block.leadsDbId === "string") out.leadsDbId = block.leadsDbId;
    if (typeof block.companiesDbId === "string") out.companiesDbId = block.companiesDbId;
    if (typeof block.dealsDbId === "string") out.dealsDbId = block.dealsDbId;
    if (typeof block.contactsDbId === "string") out.contactsDbId = block.contactsDbId;
    if (typeof block.incomeStreamsDbId === "string") {
      out.incomeStreamsDbId = block.incomeStreamsDbId;
    }
    const parsedBindings = parseBindings((block as Record<string, unknown>).bindings);
    if (parsedBindings) out.bindings = parsedBindings;
    return out;
  } catch {
    return {};
  }
}

function readFromEnv(): Partial<NotionConfig> {
  const out: Partial<NotionConfig> = {};
  if (process.env.NOTION_API_KEY) out.apiKey = process.env.NOTION_API_KEY;
  if (process.env.NOTION_PROJECTS_DB) out.projectsDbId = process.env.NOTION_PROJECTS_DB;
  if (process.env.NOTION_TASKS_DB) out.tasksDbId = process.env.NOTION_TASKS_DB;
  return out;
}

function isSyncMode(v: unknown): v is NotionSyncMode {
  return v === "off" || v === "mirror" || v === "import-once";
}

/**
 * Resolve which Notion database id to use for a given kanban source. Reads
 * the wizard-managed config first, falls back to the legacy env-var hardcoded
 * UUIDs only when nothing has been configured (preserving back-compat for
 * users who were running pre-revamp).
 */
export function resolveNotionDbId(source: "kanban-projects" | "kanban-tasks"): string | null {
  const cfg = getNotionConfig();
  if (source === "kanban-projects") return cfg.projectsDbId;
  return cfg.tasksDbId;
}

/**
 * Re-export for callers that want store-level integration with sync mode
 * (e.g. local-first kanban that records writes for later replay).
 */
export interface KanbanSyncContext {
  store: DatabasesStore;
  syncMode: NotionSyncMode;
  apiKey: string | null;
}

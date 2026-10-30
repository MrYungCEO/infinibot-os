/**
 * Canonical Notion schema definitions + reconciliation helpers.
 *
 * Why this exists:
 *   - The wizard creates Notion databases with specific shapes (e.g. Projects
 *     has Project/Status/Priority/Description/Due Date).
 *   - Operators sometimes IMPORT existing Notion databases that have
 *     differently-named properties (e.g. "Job Name" instead of "Project").
 *   - Three+ writers (`tasks/notion-sync.ts`, `agents/tools/kanban-tool.ts`,
 *     `databases/kanban-store-ops.ts`) all evolved their own schema-aware
 *     "skip unknown property" logic — same idea, four copies, drift risk.
 *
 * This module unifies those concerns:
 *   1. Canonical role definitions (`PROJECTS_ROLE`, `TASKS_ROLE`, etc.) say
 *      "InfiniBot expects these logical fields, with these legal property-
 *      name aliases, of these Notion property types."
 *   2. `getDatabaseSchema(dbId)` fetches and caches a DB's actual shape.
 *   3. `diffSchema(dbId, role)` returns missing-property additions plus
 *      legacy-named properties that could be renamed.
 *   4. `applySchemaPatch(dbId, additions)` PATCHes the Notion DB to add
 *      missing properties so an imported DB conforms to the canonical role.
 *
 * Design notes:
 *   - We never DROP a property the user has — Notion API can do that with
 *     `null` patches but it's destructive. Reconciliation is additive +
 *     rename-by-suggestion (the AI suggest path); the operator approves.
 *   - Cache TTL is short (5 min) so a freshly-patched DB picks up the new
 *     shape without a gateway restart.
 */
import { getNotionApiKeyOrNull } from "./notion-config.js";

// ─────────────────────────────────────────────────────────────────────────
// Canonical role definitions
// ─────────────────────────────────────────────────────────────────────────

/**
 * A Notion property type that InfiniBot writes. Subset of Notion's full
 * property surface — we only model the types we actually create.
 */
export type CanonicalPropertyType =
  | "title"
  | "rich_text"
  | "status"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "number"
  | "url"
  | "relation";

export interface CanonicalProperty {
  /** The canonical name InfiniBot uses to refer to this field in code. */
  canonical: string;
  /** Notion property type. */
  type: CanonicalPropertyType;
  /**
   * Acceptable property names a real Notion database could use for this
   * field. The first entry is the wizard's canonical name; later entries
   * cover legacy installs and common imported-DB variants.
   */
  aliases: readonly string[];
  /** When required, schema diff flags it as missing if no alias matches. */
  required: boolean;
  /** Default options for status/select properties when applying a schema patch. */
  options?: ReadonlyArray<{ name: string; color?: string }>;
}

export interface CanonicalRole {
  /** Stable id used in the diff/patch RPCs. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Property definitions. Order is meaningful — title field should be first. */
  properties: readonly CanonicalProperty[];
}

const STATUS_OPTIONS_PROJECTS = [
  { name: "Not started", color: "default" },
  { name: "In progress", color: "blue" },
  { name: "Reviewing", color: "yellow" },
  { name: "Completed", color: "green" },
  { name: "Paused", color: "gray" },
] as const;

const STATUS_OPTIONS_TASKS = [
  { name: "Not started", color: "default" },
  { name: "In progress", color: "blue" },
  { name: "Awaiting Response", color: "yellow" },
  { name: "Done", color: "green" },
] as const;

const PRIORITY_OPTIONS = [
  { name: "Immediate", color: "red" },
  { name: "High", color: "orange" },
  { name: "Medium", color: "yellow" },
  { name: "Low", color: "gray" },
] as const;

export const PROJECTS_ROLE: CanonicalRole = {
  id: "projects",
  label: "Projects",
  properties: [
    { canonical: "Project", type: "title", aliases: ["Project", "Name", "Title"], required: true },
    {
      canonical: "Status",
      type: "status",
      aliases: ["Status"],
      required: false,
      options: STATUS_OPTIONS_PROJECTS,
    },
    {
      canonical: "Priority",
      type: "select",
      aliases: ["Priority"],
      required: false,
      options: PRIORITY_OPTIONS,
    },
    {
      canonical: "Description",
      type: "rich_text",
      aliases: ["Description", "Notes"],
      required: false,
    },
    { canonical: "Due Date", type: "date", aliases: ["Due Date", "Due"], required: false },
    { canonical: "Deadline", type: "date", aliases: ["Deadline"], required: false },
    {
      canonical: "Active Client Project",
      type: "checkbox",
      aliases: ["Active Client Project", "Active"],
      required: false,
    },
    // Clients relation — synced bidirectionally with the Clients DB so
    // a project's linked clients round-trip through Notion. Target
    // db_id is bound at wizard time once both DBs exist, same as the
    // tasks→projects relation pattern.
    {
      canonical: "Clients",
      type: "relation",
      aliases: ["Clients", "Client"],
      required: false,
    },
  ],
};

export const TASKS_ROLE: CanonicalRole = {
  id: "tasks",
  label: "Tasks",
  properties: [
    {
      canonical: "Task Name",
      type: "title",
      aliases: ["Task Name", "Name", "Title"],
      required: true,
    },
    {
      canonical: "Status Update",
      type: "status",
      aliases: ["Status Update", "Status"],
      required: false,
      options: STATUS_OPTIONS_TASKS,
    },
    {
      canonical: "Priority Level",
      type: "select",
      aliases: ["Priority Level", "Priority"],
      required: false,
      options: PRIORITY_OPTIONS,
    },
    {
      canonical: "Description",
      type: "rich_text",
      aliases: ["Description", "Notes"],
      required: false,
    },
    { canonical: "Due Date", type: "date", aliases: ["Due Date", "Due"], required: false },
    { canonical: "Done", type: "checkbox", aliases: ["Done"], required: false },
    { canonical: "Phase", type: "rich_text", aliases: ["Phase"], required: false },
    // Project relation is created with a target db_id at wizard time; we
    // don't synthesize it via reconcile because we can't infer the target.
    { canonical: "Project", type: "relation", aliases: ["Project"], required: false },
  ],
};

export const CLIENTS_ROLE: CanonicalRole = {
  id: "clients",
  label: "Clients",
  properties: [
    { canonical: "Name", type: "title", aliases: ["Name", "Client", "Title"], required: true },
    { canonical: "Email", type: "rich_text", aliases: ["Email"], required: false },
    { canonical: "Phone", type: "rich_text", aliases: ["Phone"], required: false },
    { canonical: "Status", type: "select", aliases: ["Status"], required: false },
    { canonical: "Notes", type: "rich_text", aliases: ["Notes"], required: false },
    // Projects relation — mirror of the Clients relation on the
    // Projects DB. Notion handles the two-way pointer once both
    // properties point at each other's database.
    {
      canonical: "Projects",
      type: "relation",
      aliases: ["Projects", "Project"],
      required: false,
    },
  ],
};

export const LEADS_ROLE: CanonicalRole = {
  id: "leads",
  label: "Leads",
  properties: [
    { canonical: "Name", type: "title", aliases: ["Name", "Lead", "Title"], required: true },
    { canonical: "Source", type: "select", aliases: ["Source"], required: false },
    { canonical: "Stage", type: "select", aliases: ["Stage", "Status"], required: false },
    { canonical: "Email", type: "rich_text", aliases: ["Email"], required: false },
    { canonical: "Notes", type: "rich_text", aliases: ["Notes"], required: false },
  ],
};

export const COMPANIES_ROLE: CanonicalRole = {
  id: "companies",
  label: "Companies",
  properties: [
    { canonical: "Name", type: "title", aliases: ["Name", "Company", "Title"], required: true },
    { canonical: "Industry", type: "select", aliases: ["Industry"], required: false },
    { canonical: "Website", type: "url", aliases: ["Website", "URL"], required: false },
    { canonical: "Notes", type: "rich_text", aliases: ["Notes"], required: false },
  ],
};

export const DEALS_ROLE: CanonicalRole = {
  id: "deals",
  label: "Deals",
  properties: [
    { canonical: "Name", type: "title", aliases: ["Name", "Deal", "Title"], required: true },
    { canonical: "Stage", type: "select", aliases: ["Stage", "Status"], required: false },
    { canonical: "Amount", type: "number", aliases: ["Amount", "Value"], required: false },
    { canonical: "Close Date", type: "date", aliases: ["Close Date", "Closing"], required: false },
  ],
};

export const CONTACTS_ROLE: CanonicalRole = {
  id: "contacts",
  label: "Contacts",
  properties: [
    { canonical: "Name", type: "title", aliases: ["Name", "Contact", "Title"], required: true },
    { canonical: "Email", type: "rich_text", aliases: ["Email"], required: false },
    { canonical: "Phone", type: "rich_text", aliases: ["Phone"], required: false },
    { canonical: "Role", type: "rich_text", aliases: ["Role", "Title"], required: false },
  ],
};

export const PRODUCTS_ROLE: CanonicalRole = {
  id: "products",
  label: "Products",
  properties: [
    { canonical: "Name", type: "title", aliases: ["Name", "Product", "Title"], required: true },
    {
      canonical: "SKU",
      type: "rich_text",
      aliases: ["SKU", "Product Code", "Code"],
      required: false,
    },
    {
      canonical: "Type",
      type: "select",
      aliases: ["Type", "Product Type", "Kind"],
      required: false,
    },
    { canonical: "Status", type: "select", aliases: ["Status", "State"], required: false },
    {
      canonical: "Price",
      type: "number",
      aliases: ["Price", "Cost", "Amount", "Retail Price"],
      required: false,
    },
    {
      canonical: "Inventory",
      type: "number",
      aliases: ["Inventory", "Stock", "Qty", "Quantity"],
      required: false,
    },
    { canonical: "Category", type: "select", aliases: ["Category"], required: false },
    {
      canonical: "Description",
      type: "rich_text",
      aliases: ["Description", "Notes"],
      required: false,
    },
    { canonical: "Image", type: "url", aliases: ["Image", "Image URL", "Photo"], required: false },
    { canonical: "Tags", type: "multi_select", aliases: ["Tags"], required: false },
  ],
};

export const ROLES_BY_ID: Record<string, CanonicalRole> = {
  projects: PROJECTS_ROLE,
  tasks: TASKS_ROLE,
  clients: CLIENTS_ROLE,
  leads: LEADS_ROLE,
  companies: COMPANIES_ROLE,
  deals: DEALS_ROLE,
  contacts: CONTACTS_ROLE,
  products: PRODUCTS_ROLE,
};

// ─────────────────────────────────────────────────────────────────────────
// Schema fetch / cache
// ─────────────────────────────────────────────────────────────────────────

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface FetchedSchema {
  /** Property name → its Notion type. */
  byName: Map<string, string>;
  /** Title-typed property name (Notion permits exactly one). */
  titleProp: string | null;
  fetchedAt: number;
}

const schemaCache = new Map<string, FetchedSchema>();
const SCHEMA_TTL_MS = 5 * 60 * 1000;

function notionHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      ...notionHeaders(apiKey),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (body as { message?: string }).message ?? JSON.stringify(body);
    throw new Error(`Notion ${res.status}: ${msg}`);
  }
  return body;
}

export async function getDatabaseSchema(
  dbId: string,
  opts?: { force?: boolean },
): Promise<FetchedSchema | null> {
  const apiKey = getNotionApiKeyOrNull();
  if (!apiKey) return null;
  const now = Date.now();
  const cached = schemaCache.get(dbId);
  if (!opts?.force && cached && now - cached.fetchedAt < SCHEMA_TTL_MS) return cached;
  try {
    const db = (await notionFetch(apiKey, `/databases/${dbId}`)) as {
      properties?: Record<string, { type?: string }>;
    };
    const properties = db.properties ?? {};
    const byName = new Map<string, string>();
    let titleProp: string | null = null;
    for (const [name, def] of Object.entries(properties)) {
      const t = def?.type ?? "";
      byName.set(name, t);
      if (t === "title" && !titleProp) titleProp = name;
    }
    const fetched: FetchedSchema = { byName, titleProp, fetchedAt: now };
    schemaCache.set(dbId, fetched);
    return fetched;
  } catch {
    return cached ?? null;
  }
}

export function invalidateSchemaCache(dbId?: string): void {
  if (dbId) schemaCache.delete(dbId);
  else schemaCache.clear();
}

/**
 * Backward-compatible shape used by the legacy schema-aware writers in
 * `src/tasks/notion-sync.ts` and `src/agents/tools/kanban-tool.ts`. Both
 * modules previously kept their own cache + helper that returned this
 * exact shape; they now delegate here so an `applySchemaPatch` /
 * `applySchemaRename` invalidation reaches every reader, instead of
 * leaving the agent's cache stale for 5 minutes after a reconcile.
 */
export interface LegacySchemaShape {
  titleProp: string;
  props: Set<string>;
}

export async function getLegacySchemaShape(dbId: string): Promise<LegacySchemaShape | null> {
  const fetched = await getDatabaseSchema(dbId);
  if (!fetched || !fetched.titleProp) return null;
  return {
    titleProp: fetched.titleProp,
    props: new Set(fetched.byName.keys()),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────────────────────

export interface PropertyDiff {
  canonical: string;
  type: CanonicalPropertyType;
  /** A property that already serves this role under a non-canonical name. */
  existingAlias: string | null;
  /** True when the property is missing entirely (no alias present). */
  missing: boolean;
  /**
   * True when an existing alias is present but its Notion type doesn't
   * match the canonical type (e.g. user has "Status" as select but
   * canonical wants `status`). Reconcile won't auto-fix these — Notion
   * doesn't allow type changes via PATCH; user must recreate the property.
   */
  typeMismatch: boolean;
  /** When typeMismatch, the actual Notion type of the existing property. */
  actualType: string | null;
}

export interface SchemaDiff {
  dbId: string;
  role: string;
  titleProp: string | null;
  diffs: PropertyDiff[];
  /** Convenience flag: true iff every required property has a usable alias. */
  satisfiesRequired: boolean;
}

export async function diffSchema(dbId: string, roleId: string): Promise<SchemaDiff | null> {
  const role = ROLES_BY_ID[roleId];
  if (!role) return null;
  const fetched = await getDatabaseSchema(dbId);
  if (!fetched) return null;

  const diffs: PropertyDiff[] = [];
  let satisfiesRequired = true;

  for (const prop of role.properties) {
    let existingAlias: string | null = null;
    let actualType: string | null = null;
    for (const alias of prop.aliases) {
      const t = fetched.byName.get(alias);
      if (t !== undefined) {
        existingAlias = alias;
        actualType = t;
        break;
      }
    }
    const missing = existingAlias === null;
    const typeMismatch = !missing && actualType !== prop.type;
    if (missing && prop.required) satisfiesRequired = false;
    diffs.push({
      canonical: prop.canonical,
      type: prop.type,
      existingAlias,
      missing,
      typeMismatch,
      actualType,
    });
  }

  return { dbId, role: roleId, titleProp: fetched.titleProp, diffs, satisfiesRequired };
}

// ─────────────────────────────────────────────────────────────────────────
// Apply patch (additive)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the Notion `properties` payload for adding the listed canonical
 * properties to an existing database. Only adds properties that aren't
 * already present (by canonical name) — never overwrites or renames.
 *
 * The relation type is excluded because creating a relation requires a
 * target database id we don't have at reconcile time.
 */
export function buildAdditivePatch(
  role: CanonicalRole,
  missing: PropertyDiff[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const m of missing) {
    if (!m.missing) continue;
    const def = role.properties.find((p) => p.canonical === m.canonical);
    if (!def) continue;
    if (def.type === "title") continue; // every Notion DB already has exactly one title
    if (def.type === "relation") continue; // needs target db id; reconcile can't fabricate
    properties[def.canonical] = propertyTypePayload(def);
  }
  return properties;
}

function propertyTypePayload(def: CanonicalProperty): Record<string, unknown> {
  switch (def.type) {
    case "rich_text":
      return { rich_text: {} };
    case "status":
      return def.options
        ? { status: { options: def.options.map((o) => ({ ...o })) } }
        : { status: {} };
    case "select":
      return def.options
        ? { select: { options: def.options.map((o) => ({ ...o })) } }
        : { select: {} };
    case "multi_select":
      return def.options
        ? { multi_select: { options: def.options.map((o) => ({ ...o })) } }
        : { multi_select: {} };
    case "date":
      return { date: {} };
    case "checkbox":
      return { checkbox: {} };
    case "number":
      return { number: { format: "number" } };
    case "url":
      return { url: {} };
    case "relation":
      // Caller must provide database_id explicitly — we don't reach here for
      // reconcile because relations are skipped above.
      throw new Error("relation properties require an explicit target database_id");
    default:
      return {};
  }
}

export async function applySchemaPatch(
  dbId: string,
  role: CanonicalRole,
  diff: SchemaDiff,
): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const apiKey = getNotionApiKeyOrNull();
  if (!apiKey) throw new Error("Notion API key not configured");
  const additivePayload = buildAdditivePatch(role, diff.diffs);
  const applied = Object.keys(additivePayload);
  const skipped = diff.diffs
    .filter((d) => d.typeMismatch || (d.missing && (d.type === "title" || d.type === "relation")))
    .map((d) => d.canonical);
  if (applied.length === 0) return { applied: [], skipped };
  await notionFetch(apiKey, `/databases/${dbId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: additivePayload }),
  });
  // Bust the cache so the next read sees the fresh shape.
  invalidateSchemaCache(dbId);
  return { applied, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// AI-assisted suggestion (used for imported DBs whose names don't match
// any alias). Caller passes the diff + the actual Notion property names;
// we ask the configured LLM for a {existing → canonical} mapping. The
// LLM call is wrapped in a try/catch so a missing model never breaks the
// reconcile flow — the operator can still apply the additive patch.
// ─────────────────────────────────────────────────────────────────────────

export interface PropertyMappingSuggestion {
  /** Existing Notion property name → canonical InfiniBot field name. */
  mapping: Record<string, string>;
  /** Confidence note from the model, surfaced in the UI for the operator. */
  rationale: string;
}

/**
 * Build the prompt + parse the response. Pure function so callers can swap
 * the LLM transport (pi-ai stream, claude-code, mock for tests) without
 * leaking that detail into the schema module.
 */
export function buildAiSuggestPrompt(
  role: CanonicalRole,
  existingProps: Array<{ name: string; type: string }>,
): { system: string; user: string } {
  const canonicalList = role.properties
    .map((p) => `- ${p.canonical} (${p.type})${p.required ? " [required]" : ""}`)
    .join("\n");
  const existingList = existingProps.map((p) => `- ${p.name} (${p.type})`).join("\n");
  const system =
    "You map Notion database properties to InfiniBot's canonical schema. " +
    "Return ONLY a JSON object of the form " +
    `{"mapping": {"<existing>": "<canonical>"}, "rationale": "<one sentence>"}. ` +
    "Only include mappings where the existing property is plausibly the same field (semantically AND type-compatible). " +
    "Do NOT invent canonical names that aren't in the provided list. Do NOT include identity mappings.";
  const user =
    `Role: ${role.label} (id: ${role.id})\n\n` +
    `Canonical properties:\n${canonicalList}\n\n` +
    `Existing Notion database properties:\n${existingList}`;
  return { system, user };
}

/**
 * Apply a {existing → canonical} mapping to the Notion database by sending
 * a PATCH that renames each existing property. Notion accepts:
 *
 *   PATCH /databases/{id}
 *   { "properties": { "Old Name": { "name": "New Name" } } }
 *
 * Validation:
 *   - Each target must be a canonical name in `role`.
 *   - Refuses to rename a property to a name that already exists on the DB
 *     (Notion would 409). The caller can apply additions first and then
 *     renames in a second pass if they want a clean re-shape.
 *   - Title properties can be renamed (Notion permits this).
 *
 * Returns which renames were applied vs skipped + reason.
 */
export async function applySchemaRename(
  dbId: string,
  role: CanonicalRole,
  mapping: Record<string, string>,
): Promise<{
  applied: Array<{ from: string; to: string }>;
  skipped: Array<{ from: string; to: string; reason: string }>;
}> {
  const apiKey = getNotionApiKeyOrNull();
  if (!apiKey) throw new Error("Notion API key not configured");

  const fetched = await getDatabaseSchema(dbId, { force: true });
  if (!fetched) throw new Error("Database not reachable");

  const validCanonical = new Set(role.properties.map((p) => p.canonical));
  const applied: Array<{ from: string; to: string }> = [];
  const skipped: Array<{ from: string; to: string; reason: string }> = [];
  const properties: Record<string, unknown> = {};

  for (const [from, to] of Object.entries(mapping)) {
    if (!validCanonical.has(to)) {
      skipped.push({ from, to, reason: "target is not a canonical property name" });
      continue;
    }
    if (!fetched.byName.has(from)) {
      skipped.push({ from, to, reason: "source property doesn't exist on the database" });
      continue;
    }
    if (from === to) {
      skipped.push({ from, to, reason: "identity rename" });
      continue;
    }
    if (fetched.byName.has(to)) {
      // Notion will 409 if we try to rename onto an existing property name.
      // Surface the conflict so the caller can decide whether to delete the
      // existing property first (we won't do that automatically — destructive).
      skipped.push({ from, to, reason: `target name "${to}" already exists on the database` });
      continue;
    }
    properties[from] = { name: to };
    applied.push({ from, to });
  }

  if (applied.length === 0) return { applied: [], skipped };

  await notionFetch(apiKey, `/databases/${dbId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  invalidateSchemaCache(dbId);
  return { applied, skipped };
}

export function parseAiSuggestResponse(
  raw: string,
  role: CanonicalRole,
): PropertyMappingSuggestion {
  // Try fenced JSON first, then raw.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = (fenceMatch ? fenceMatch[1] : raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { mapping: {}, rationale: "Model response was not valid JSON; ignoring." };
  }
  const obj = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) as {
    mapping?: unknown;
    rationale?: unknown;
  };
  const validCanonical = new Set(role.properties.map((p) => p.canonical));
  const mapping: Record<string, string> = {};
  if (obj.mapping && typeof obj.mapping === "object" && !Array.isArray(obj.mapping)) {
    for (const [existing, target] of Object.entries(obj.mapping as Record<string, unknown>)) {
      if (typeof target !== "string") continue;
      if (!validCanonical.has(target)) continue;
      if (existing === target) continue;
      mapping[existing] = target;
    }
  }
  return {
    mapping,
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

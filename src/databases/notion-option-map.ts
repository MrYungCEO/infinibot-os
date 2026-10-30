/**
 * Map local kanban values (status ids like `review`, priorities like `high`)
 * onto the options a Notion database ACTUALLY has, so we never push an
 * option Notion rejects.
 *
 * Why: Notion `status` properties refuse unknown option names with a 400
 * ("Invalid status option. Status option "review" does not exist"), and
 * `select` properties silently create a new option for every unknown name
 * (so "high" next to "High" pollutes the user's board). The kanban used to
 * push local ids verbatim, which left rows retrying forever.
 *
 * Resolution order for one value (first hit wins):
 *   1. explicit operator override (`notion.optionMap` in infinibot.json,
 *      keyed by role then local value),
 *   2. exact option name (case/spacing-insensitive),
 *   3. built-in aliases for the canonical local ids (review → "In review",
 *      "Review", "Awaiting Response", …),
 *   4. for status properties: the status group the local value belongs to
 *      (todo → "To-do" group, in_progress/review → "In progress", done →
 *      "Complete"), picking that group's first option,
 *   5. null — the caller omits the property instead of sending a bad name.
 *
 * The schema (one GET /databases/:id) is cached per DB for SCHEMA_TTL_MS and
 * can be invalidated when Notion rejects a value (the user may have renamed
 * options since).
 */

import { loadConfig as loadAppConfig } from "../config/io.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
export const SCHEMA_TTL_MS = 10 * 60_000;

export interface NotionOptionSchemaProp {
  name: string;
  type: "status" | "select" | "multi_select";
  options: string[];
  /** Status groups (To-do / In progress / Complete) → option names. */
  groups?: Array<{ name: string; options: string[] }>;
}

export interface NotionDbOptionSchema {
  dbId: string;
  fetchedAt: number;
  props: Record<string, NotionOptionSchemaProp>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Test hook. */
export function setNotionOptionFetcherForTests(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
  schemaCache.clear();
}

const schemaCache = new Map<string, { at: number; schema: NotionDbOptionSchema }>();
const schemaInflight = new Map<string, Promise<NotionDbOptionSchema>>();

export function invalidateNotionOptionSchema(dbId?: string): void {
  if (dbId) schemaCache.delete(dbId);
  else schemaCache.clear();
}

/** Parse the `properties` block of a GET /databases/:id response. */
export function parseNotionOptionSchema(dbId: string, body: unknown): NotionDbOptionSchema {
  const props: Record<string, NotionOptionSchemaProp> = {};
  const raw = ((body as { properties?: Record<string, any> })?.properties ?? {}) as Record<
    string,
    any
  >;
  for (const [name, p] of Object.entries(raw)) {
    const type = p?.type;
    if (type !== "status" && type !== "select" && type !== "multi_select") continue;
    const block = p[type] ?? {};
    const opts: Array<{ id?: string; name?: string }> = Array.isArray(block.options)
      ? block.options
      : [];
    const options = opts.map((o) => o?.name).filter((n): n is string => typeof n === "string");
    const out: NotionOptionSchemaProp = { name, type, options };
    if (type === "status" && Array.isArray(block.groups)) {
      const byId = new Map(opts.map((o) => [o.id, o.name]));
      out.groups = block.groups.map((g: any) => ({
        name: String(g?.name ?? ""),
        options: (Array.isArray(g?.option_ids) ? g.option_ids : [])
          .map((id: string) => byId.get(id))
          .filter((n: unknown): n is string => typeof n === "string"),
      }));
    }
    props[name] = out;
  }
  return { dbId, fetchedAt: Date.now(), props };
}

/** Fetch (cached) the status/select options of one Notion database. */
export async function getNotionOptionSchema(
  apiKey: string,
  dbId: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<NotionDbOptionSchema> {
  const hit = schemaCache.get(dbId);
  if (!opts.force && hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.schema;
  const inflight = schemaInflight.get(dbId);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await fetcher(`${NOTION_API_URL}/databases/${dbId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Notion API ${res.status}: ${(body as { message?: string })?.message ?? "schema fetch failed"}`,
      );
    }
    const schema = parseNotionOptionSchema(dbId, body);
    schemaCache.set(dbId, { at: Date.now(), schema });
    return schema;
  })();
  schemaInflight.set(dbId, p);
  try {
    return await p;
  } finally {
    schemaInflight.delete(dbId);
  }
}

/** Seed the cache (tests, or callers that already hold a fresh schema). */
export function primeNotionOptionSchema(schema: NotionDbOptionSchema): void {
  schemaCache.set(schema.dbId, { at: Date.now(), schema });
}

// ── Resolution ─────────────────────────────────────────────────────────

const norm = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** Aliases tried (in order) for canonical local values. Keys are normalized. */
const DEFAULT_ALIASES: Record<string, string[]> = {
  // statuses
  backlog: ["Backlog", "Not started", "To Do", "To-do", "Todo", "Upcoming"],
  todo: ["To Do", "Not started", "To-do", "Todo", "Backlog", "Upcoming"],
  inprogress: ["In progress", "In Progress", "Doing", "Active", "Started", "Updating"],
  review: [
    "In review",
    "Review",
    "Reviewing",
    "Review / Blocked",
    "Awaiting Response",
    "Awaiting Client",
    "Awaiting review",
    "Revisit",
    "Blocked",
  ],
  blocked: ["Blocked", "Review / Blocked", "Awaiting Response", "Paused"],
  done: ["Done", "Complete", "Completed", "Finished"],
  completed: ["Completed", "Complete", "Done"],
  cancelled: ["Cancelled", "Canceled", "Archived"],
  paused: ["Paused", "On hold", "Blocked"],
  notstarted: ["Not started", "To Do", "Todo", "To-do", "Backlog"],
  // priorities
  critical: ["Immediate", "Critical", "Urgent", "Highest"],
  urgent: ["Urgent", "Immediate", "Critical"],
  immediate: ["Immediate", "Urgent", "Critical"],
  high: ["High"],
  medium: ["Medium", "Normal"],
  normal: ["Normal", "Medium"],
  low: ["Low", "Lowest"],
};

/** Which Notion status group a local value belongs to. */
const STATUS_GROUP: Record<string, "todo" | "progress" | "complete"> = {
  backlog: "todo",
  todo: "todo",
  notstarted: "todo",
  upcoming: "todo",
  inprogress: "progress",
  review: "progress",
  blocked: "progress",
  paused: "progress",
  done: "complete",
  completed: "complete",
  cancelled: "complete",
};

function groupMatches(groupName: string, want: "todo" | "progress" | "complete"): boolean {
  const g = norm(groupName);
  if (want === "todo") return g === "todo" || g.includes("todo") || g.includes("notstarted");
  if (want === "progress") return g.includes("progress");
  return g.includes("complete") || g.includes("done");
}

/** "projects", "tasks", or any other option-map role. */
export type OptionRole = string;

/** Operator overrides: `notion.optionMap[role][localValue] = "Notion option"`. */
export function readOptionOverrides(): Record<string, Record<string, string>> {
  try {
    const cfg = (loadAppConfig() ?? {}) as Record<string, any>;
    const m = cfg?.notion?.optionMap;
    return m && typeof m === "object" ? (m as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

export interface ResolveOptionResult {
  name: string | null;
  via: "override" | "exact" | "alias" | "group" | "none";
}

/**
 * Resolve one local value against a Notion property's real options. Pure —
 * no I/O; pass `overrides` for the role (or {}).
 */
export function resolveNotionOption(
  prop: NotionOptionSchemaProp | undefined,
  localValue: string | null | undefined,
  overrides: Record<string, string> = {},
): ResolveOptionResult {
  if (localValue == null || String(localValue).trim() === "") return { name: null, via: "none" };
  const value = String(localValue).trim();
  // No schema (property missing or not an option type): nothing we can
  // validate against — the caller decides (usually: omit).
  if (!prop || prop.options.length === 0) return { name: null, via: "none" };
  const byNorm = new Map<string, string>();
  for (const o of prop.options) if (!byNorm.has(norm(o))) byNorm.set(norm(o), o);

  const ov = overrides[value] ?? overrides[value.toLowerCase()] ?? overrides[norm(value)];
  if (ov) {
    const hit = byNorm.get(norm(ov));
    if (hit) return { name: hit, via: "override" };
  }
  const exact = byNorm.get(norm(value));
  if (exact) return { name: exact, via: "exact" };
  for (const alias of DEFAULT_ALIASES[norm(value)] ?? []) {
    const hit = byNorm.get(norm(alias));
    if (hit) return { name: hit, via: "alias" };
  }
  if (prop.type === "status") {
    const want = STATUS_GROUP[norm(value)];
    if (want && prop.groups?.length) {
      const g = prop.groups.find((gr) => groupMatches(gr.name, want) && gr.options.length > 0);
      if (g) {
        // Inside "In progress", prefer the group's literal "In progress"
        // option for in_progress, otherwise the first non-default option.
        return { name: g.options[0]!, via: "group" };
      }
    }
  }
  return { name: null, via: "none" };
}

/**
 * Convenience: resolve a value for a named property of a Notion DB, fetching
 * the schema if needed. Returns null when the value can't be mapped (caller
 * omits the property). Never throws for schema-fetch failures when
 * `failOpen` is set — returns `{ unknown: true }` so the caller can decide.
 */
export async function resolveOptionForDb(
  apiKey: string,
  dbId: string,
  propertyName: string,
  role: OptionRole,
  localValue: string | null | undefined,
): Promise<ResolveOptionResult & { propType?: NotionOptionSchemaProp["type"] }> {
  const schema = await getNotionOptionSchema(apiKey, dbId);
  const prop = schema.props[propertyName];
  const overrides = readOptionOverrides()[role] ?? {};
  return { ...resolveNotionOption(prop, localValue, overrides), propType: prop?.type };
}

/** Pick the first property name (of an option type) that exists in the schema. */
export function pickSchemaProp(
  schema: NotionDbOptionSchema,
  candidates: readonly string[],
): NotionOptionSchemaProp | undefined {
  for (const c of candidates) {
    const p = schema.props[c];
    if (p) return p;
  }
  return undefined;
}

/**
 * Request-level guard for any code path that writes Notion pages directly
 * (agent kanban tool, kanban RPCs, the legacy tasks/notion-sync pusher).
 * For `POST /pages` and `PATCH /pages/:id` bodies it maps every `status` /
 * `select` value onto the target DB's real options:
 *   - status values that can't be mapped are DROPPED (Notion would 400);
 *   - select values are canonicalised ("high" → "High") when they match an
 *     existing option, and otherwise left alone (free-form selects such as a
 *     federation node name legitimately create options).
 * The target DB is `parent.database_id` when present, else whichever of
 * `candidateDbIds` has the most of the written properties. If the schema
 * can't be fetched the body is returned unchanged (never blocks a write).
 */
export async function sanitizeNotionPageWrite(
  apiKey: string,
  reqPath: string,
  method: string | undefined,
  body: string | undefined,
  candidateDbIds: Array<string | null | undefined>,
  role?: OptionRole,
): Promise<string | undefined> {
  const m = (method ?? "GET").toUpperCase();
  if (!body || (m !== "POST" && m !== "PATCH")) return body;
  if (!/^\/pages(\/[^/?]+)?\/?$/.test(reqPath.split("?")[0] ?? "")) return body;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const props = parsed?.properties as Record<string, any> | undefined;
  if (!props || typeof props !== "object") return body;
  const optionKeys = Object.keys(props).filter(
    (k) =>
      props[k] && typeof props[k] === "object" && ("status" in props[k] || "select" in props[k]),
  );
  if (optionKeys.length === 0) return body;
  const parentDb: string | undefined = parsed?.parent?.database_id;
  const dbIds = (parentDb ? [parentDb] : candidateDbIds).filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  let best: NotionDbOptionSchema | null = null;
  let bestScore = 0;
  for (const id of dbIds) {
    let schema: NotionDbOptionSchema;
    try {
      schema = await getNotionOptionSchema(apiKey, id);
    } catch {
      continue;
    }
    const score = optionKeys.filter((k) => schema.props[k]).length;
    if (score > bestScore) {
      best = schema;
      bestScore = score;
    }
  }
  if (!best) return body;
  const overrides = role ? (readOptionOverrides()[role] ?? {}) : {};
  let changed = false;
  for (const k of optionKeys) {
    const prop = best.props[k];
    if (!prop) continue;
    const v = props[k];
    if ("status" in v) {
      const raw = v.status?.name;
      if (raw == null) continue;
      const { name } = resolveNotionOption(prop, raw, overrides);
      if (!name) {
        delete props[k];
        changed = true;
      } else if (name !== raw) {
        props[k] = { status: { name } };
        changed = true;
      }
    } else if ("select" in v) {
      const raw = v.select?.name;
      if (raw == null) continue;
      const { name, via } = resolveNotionOption(prop, raw, overrides);
      if (name && name !== raw && via !== "group") {
        props[k] = { select: { name } };
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(parsed) : body;
}

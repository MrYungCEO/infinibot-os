/**
 * Gateway RPCs for the unified Notion import wizard.
 *
 * One coherent flow that subsumes the three pre-existing fragments:
 *   1. notion.wizard.* — only created NEW system DBs (Projects/Tasks/CRM).
 *   2. notion.db.*     — separate CRUD for arbitrary DBs that doesn't share
 *                        a binding registry with #1, so imports never
 *                        participated in bidirectional sync.
 *   3. notion.schema.* — schema reconciliation against canonical roles.
 *
 * The unified import flow plumbs all three through the bindings registry:
 *   - listDatabases:  surface every DB the integration can see, plus a
 *                     suggested role per DB (fuzzy-match name + properties).
 *   - preview:        diff a candidate DB against a chosen role, return
 *                     the proposed field map + missing/conflict report.
 *   - scanRelations:  enumerate cross-DB relation columns so the wizard
 *                     can prompt "also import the related DB?".
 *   - commit:         write the binding (with the operator-approved field
 *                     map), apply additive schema patch if requested,
 *                     trigger an initial backfill via the bidirectional
 *                     poller's runPollOnce.
 */
import { listAccessibleDatabases } from "../../databases/notion-wizard.js";
import { getAllBusinessNotionDbIds } from "./business.js";
import {
  getAllBindings,
  getBinding,
  getBindingsByRole,
  getNotionApiKeyForImport,
  getNotionConfig,
  upsertBinding,
  removeBinding,
  writeNotionConfig,
  type NotionBinding,
  type NotionRoleId,
  type ConflictPolicy,
} from "../../databases/notion-config.js";
import {
  ROLES_BY_ID,
  applySchemaPatch,
  diffSchema,
  getDatabaseSchema,
  type CanonicalRole,
  type SchemaDiff,
} from "../../databases/notion-schema.js";
import { pollNotionNow } from "../../databases/notion-bidirectional-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("notion-import-rpc");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionFetch(apiKey: string, path: string): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Notion ${res.status}: ${(body as { message?: string }).message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

/**
 * Rough role suggestion based on DB title + property names. Cheap heuristic
 * so the wizard auto-selects the most likely role without forcing the user
 * to pick from a dropdown for every DB. The operator can always override
 * — this is a default, not a verdict.
 */
function suggestRole(title: string, propertyNames: string[]): NotionRoleId {
  const t = title.toLowerCase();
  const props = new Set(propertyNames.map((p) => p.toLowerCase()));
  // Products: title or property-set strongly indicates a catalog. Check
  // before the generic patterns so "Product Status" / "Product Tasks"
  // names don't mis-route.
  if (/\bproduct/.test(t) || /\bcatalog/.test(t) || /\bsku\b/.test(t)) return "products";
  if (props.has("sku") && (props.has("price") || props.has("inventory") || props.has("stock"))) {
    return "products";
  }
  if (/\bproject/.test(t) && !/\btask/.test(t)) return "projects";
  if (/\btask/.test(t) || /\bto[-\s]?do/.test(t)) return "tasks";
  if (/\bclient/.test(t)) return "clients";
  if (/\blead/.test(t)) return "leads";
  if (/\bcompan/.test(t)) return "companies";
  if (/\bdeal/.test(t) || /\bopportunit/.test(t)) return "deals";
  if (/\bcontact/.test(t) || /\bperson/.test(t) || /\bpeople/.test(t)) return "contacts";
  // Property-based fallbacks for un-named or differently-titled DBs.
  if (props.has("status") && (props.has("priority") || props.has("priority level"))) {
    if (props.has("done") || props.has("task name")) return "tasks";
    return "projects";
  }
  if (props.has("email") && props.has("phone")) return "clients";
  return "custom";
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

/**
 * Build a default field map for a (role, schema) pair. The wizard sends
 * this back to the UI as a proposal; the operator can edit before commit.
 *
 * For each canonical property in the role, pick the first matching alias
 * in the actual Notion schema. Unmatched canonical fields leave the map
 * entry undefined so the UI can render them as "not mapped".
 */
function proposeFieldMap(role: CanonicalRole, schemaPropNames: string[]): Record<string, string> {
  // Three-tier matching so the user lands on the mapping screen with sensible
  // defaults instead of every dropdown set to "ignore". Order is strictest →
  // loosest; each tier only runs for properties the prior tier missed.
  //
  //   1. alias hit  — exact case-insensitive match of any declared alias
  //   2. substring  — canonical name contains or is contained in a Notion
  //                   property name (e.g. canonical "Project" → Notion
  //                   "Project Title")
  //   3. similarity — Levenshtein-based score ≥ FUZZY_THRESHOLD against
  //                   the canonical name (e.g. "Description" → "Descriptn")
  //
  // A Notion property can only be claimed once — once it's mapped to one
  // canonical, the looser tiers won't reassign it to another.
  const namesLower = new Map(schemaPropNames.map((n) => [n.toLowerCase(), n]));
  const claimed = new Set<string>();
  const out: Record<string, string> = {};

  // Tier 1: alias match.
  for (const prop of role.properties) {
    for (const alias of prop.aliases) {
      const found = namesLower.get(alias.toLowerCase());
      if (found && !claimed.has(found)) {
        out[prop.canonical] = found;
        claimed.add(found);
        break;
      }
    }
  }

  // Tier 2: substring containment between canonical name and property name.
  for (const prop of role.properties) {
    if (out[prop.canonical]) continue;
    const canonNorm = prop.canonical.toLowerCase();
    for (const name of schemaPropNames) {
      if (claimed.has(name)) continue;
      const nameNorm = name.toLowerCase();
      if (canonNorm.length >= 3 && (nameNorm.includes(canonNorm) || canonNorm.includes(nameNorm))) {
        out[prop.canonical] = name;
        claimed.add(name);
        break;
      }
    }
  }

  // Tier 3: best-similarity fallback. Only kicks in when neither alias nor
  // substring matched — this is what catches "Descriptn" → "Description" and
  // "Stage" → "Pipeline Stage" (the latter often gets caught by tier 2 first).
  for (const prop of role.properties) {
    if (out[prop.canonical]) continue;
    const canonNorm = normalizeTitle(prop.canonical);
    let best: { name: string; score: number } | null = null;
    for (const name of schemaPropNames) {
      if (claimed.has(name)) continue;
      const score = similarity(canonNorm, normalizeTitle(name));
      if (score < FUZZY_THRESHOLD) continue;
      if (!best || score > best.score) best = { name, score };
    }
    if (best) {
      out[prop.canonical] = best.name;
      claimed.add(best.name);
    }
  }

  return out;
}

export const notionImportHandlers: GatewayRequestHandlers = {
  /**
   * List every Notion DB the integration can see, with a per-DB role
   * suggestion and "already bound?" flag. Single round-trip the wizard
   * uses to render its DB picker step.
   */
  "notion.import.listDatabases": async ({ params, respond }) => {
    const apiKey = getNotionApiKeyForImport();
    if (!apiKey) {
      respond(false, undefined, { code: "NOT_CONFIGURED", message: "Notion not configured" });
      return;
    }
    try {
      const cfg = getNotionConfig();
      const managedIds: string[] = [
        cfg.projectsDbId,
        cfg.tasksDbId,
        cfg.clientsDbId,
        cfg.leadsDbId,
        cfg.companiesDbId,
        cfg.dealsDbId,
        cfg.contactsDbId,
      ].filter((id): id is string => !!id);
      // Surface DBs that /search misses: every binding we've ever made +
      // every DB id attached to a business profile. Notion's `/search`
      // skips databases shared via a parent page; `/databases/{id}` returns
      // them. listAccessibleDatabases probes each id and unions the result.
      // Operator-supplied manualIds (pasted URLs/IDs from the wizard's
      // "Add by URL" input) are appended too, so an integration that can
      // read a database but isn't surfacing it in /search can still pull
      // it in by hand.
      const manualIds = Array.isArray((params as Record<string, unknown> | undefined)?.manualIds)
        ? ((params as Record<string, unknown>).manualIds as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
      const knownIds: string[] = [
        ...managedIds,
        ...Object.keys(cfg.bindings ?? {}),
        ...getAllBusinessNotionDbIds(),
        ...manualIds,
      ];
      let dbs: Array<Awaited<ReturnType<typeof listAccessibleDatabases>>[number]>;
      try {
        dbs = await listAccessibleDatabases(apiKey, managedIds, knownIds);
      } catch (err) {
        // Map common Notion failures to actionable error codes so the UI
        // can render a real "fix this" message instead of an empty picker.
        const msg = (err as Error).message ?? String(err);
        const code = /401|unauthorized|invalid_token|invalid api token|invalid_api_key/i.test(msg)
          ? "NOTION_AUTH_FAILED"
          : /403|restricted_resource|insufficient_permission/i.test(msg)
            ? "NOTION_FORBIDDEN"
            : /429|rate.?limit/i.test(msg)
              ? "NOTION_RATE_LIMITED"
              : "NOTION_API_ERROR";
        respond(false, undefined, { code, message: `Notion: ${msg}` });
        return;
      }

      // Decorate each DB with role suggestion + binding presence. Property
      // names need the schema fetch; we already get propertyCount but not
      // names, so do a parallel best-effort enrichment.
      const enriched = await Promise.all(
        dbs.map(async (db) => {
          let propertyNames: string[] = [];
          try {
            const schema = await getDatabaseSchema(db.id);
            if (schema) propertyNames = Array.from(schema.byName.keys());
          } catch {
            /* leave empty — suggestion will fall back to title-only */
          }
          const suggested = suggestRole(db.title, propertyNames);
          const existingBinding = getBinding(db.id);
          return {
            ...db,
            propertyNames,
            suggestedRole: suggested,
            existingBinding: existingBinding
              ? {
                  role: existingBinding.role,
                  conflictPolicy: existingBinding.conflictPolicy,
                  fieldMap: existingBinding.fieldMap,
                  lastSyncedAt: existingBinding.lastSyncedAt,
                }
              : null,
          };
        }),
      );
      respond(true, { databases: enriched });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Probe a single Notion database by id. Used by the import wizard's
   * "Add by URL/ID" flow when /search doesn't list a database the
   * integration can technically read (the long-standing platform quirk
   * where a database shared via a parent page is invisible to /search).
   * Returns the DB info on success, a structured error on failure so the
   * UI can render an actionable hint instead of a silent empty state.
   */
  "notion.import.probeDatabase": async ({ params, respond }) => {
    const apiKey = getNotionApiKeyForImport();
    if (!apiKey) {
      respond(false, undefined, { code: "NOT_CONFIGURED", message: "Notion not configured" });
      return;
    }
    const dbId = typeof params?.dbId === "string" ? params.dbId.trim() : "";
    if (!dbId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId is required" });
      return;
    }
    try {
      const res = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
        },
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        const db = body as {
          id: string;
          url?: string;
          last_edited_time?: string;
          title?: Array<{ plain_text?: string }>;
          properties?: Record<string, unknown>;
        };
        const title = Array.isArray(db.title)
          ? db.title
              .map((t) => t?.plain_text ?? "")
              .join("")
              .trim() || "Untitled"
          : "Untitled";
        respond(true, {
          database: {
            id: db.id,
            title,
            url: db.url,
            lastEditedAt: db.last_edited_time ? new Date(db.last_edited_time).getTime() : 0,
            propertyCount: Object.keys(db.properties ?? {}).length,
            propertyNames: Object.keys(db.properties ?? {}),
            isSystemManaged: false,
          },
        });
        return;
      }
      // Notion error — map to actionable hints.
      const message = String((body as { message?: string }).message ?? "");
      const status = res.status;
      if (status === 404 || /object_not_found/i.test(message)) {
        respond(false, undefined, {
          code: "NOTION_NOT_FOUND",
          message:
            "Notion couldn't find a database with that id. Double-check the URL — the id is the 32-character hex string at the end.",
        });
      } else if (status === 403 || /restricted_resource|insufficient_permission/i.test(message)) {
        respond(false, undefined, {
          code: "NOTION_FORBIDDEN",
          message:
            "The integration doesn't have access to this database. In Notion, open the database → '•••' menu → Connections → add this integration. Then try again.",
        });
      } else if (status === 401 || /invalid api token|unauthorized/i.test(message)) {
        respond(false, undefined, {
          code: "NOTION_AUTH_FAILED",
          message: "Notion rejected the API key. Re-verify the integration token.",
        });
      } else {
        respond(false, undefined, {
          code: "NOTION_API_ERROR",
          message: `Notion ${status}: ${message || JSON.stringify(body)}`,
        });
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * For a (dbId, role) candidate: return the schema diff, the proposed
   * field map, and a list of every Notion property the operator might
   * want to map manually. The wizard renders this as a 3-column table:
   *   Notion property → InfiniBot field → Action.
   *
   * Read-only — never patches Notion. The commit step does that.
   */
  "notion.import.preview": async ({ params, respond }) => {
    const dbId = typeof params?.dbId === "string" ? params.dbId : "";
    const roleId = typeof params?.role === "string" ? params.role : "";
    if (!dbId || !roleId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId and role required" });
      return;
    }
    if (!isRoleId(roleId)) {
      respond(false, undefined, { code: "BAD_REQUEST", message: `unknown role: ${roleId}` });
      return;
    }
    try {
      const schema = await getDatabaseSchema(dbId, { force: true });
      if (!schema) {
        respond(false, undefined, {
          code: "NOT_AVAILABLE",
          message: "DB unreachable — check the integration has access.",
        });
        return;
      }
      const propertyNames = Array.from(schema.byName.keys());
      const propsWithType = propertyNames.map((name) => ({
        name,
        type: schema.byName.get(name) ?? "unknown",
      }));

      let diff: SchemaDiff | null = null;
      let proposedFieldMap: Record<string, string> = {};
      if (roleId !== "custom") {
        const role = ROLES_BY_ID[roleId];
        if (role) {
          diff = await diffSchema(dbId, roleId);
          proposedFieldMap = proposeFieldMap(role, propertyNames);
        }
      } else {
        // For custom roles the field map is identity over every property.
        for (const n of propertyNames) proposedFieldMap[n] = n;
      }

      respond(true, {
        dbId,
        role: roleId,
        propertyNames,
        properties: propsWithType,
        diff,
        proposedFieldMap,
        existingBinding: getBinding(dbId),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Walk the relation columns of one or more DBs and report which target
   * databases are NOT yet imported. The wizard uses this to prompt the
   * operator: "Tasks relates to 'Client Work'. Also import that DB?"
   */
  "notion.import.scanRelations": async ({ params, respond }) => {
    const dbIds = Array.isArray(params?.dbIds)
      ? (params.dbIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (dbIds.length === 0) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbIds required" });
      return;
    }
    const apiKey = getNotionApiKeyForImport();
    if (!apiKey) {
      respond(false, undefined, { code: "NOT_CONFIGURED", message: "Notion not configured" });
      return;
    }
    try {
      const cfg = getNotionConfig();
      const knownIds = new Set([
        ...Object.keys(cfg.bindings),
        ...dbIds, // treat the just-selected set as "will be imported"
      ]);
      // Also build a lookup from (normalized) Notion id → bound role so
      // the UI can render "Already bound to Tasks" instead of just
      // "known". This lets the swap modal flag relation reassignments
      // ("this Tasks DB relates to Projects you've already bound").
      const stripDashes = (id: string) => id.replace(/-/g, "").toLowerCase();
      const roleByNormId = new Map<string, string>();
      for (const b of Object.values(cfg.bindings)) {
        roleByNormId.set(stripDashes(b.notionDbId), b.role);
      }
      const relations: Array<{
        sourceDbId: string;
        sourceProp: string;
        targetDbId: string;
        targetTitle: string;
        targetIsKnown: boolean;
        targetRole: string | null;
      }> = [];
      for (const sourceId of dbIds) {
        let db: any;
        try {
          db = await notionFetch(apiKey, `/databases/${sourceId}`);
        } catch (err) {
          log.warn("scanRelations: db fetch failed", { sourceId, err: String(err) });
          continue;
        }
        for (const [propName, propDef] of Object.entries(db.properties ?? {})) {
          const def = propDef as { type?: string; relation?: { database_id?: string } };
          if (def.type !== "relation") continue;
          const targetDbId = def.relation?.database_id;
          if (!targetDbId) continue;
          let targetTitle = "Untitled";
          try {
            const target = (await notionFetch(apiKey, `/databases/${targetDbId}`)) as {
              title?: Array<{ plain_text?: string }>;
            };
            if (Array.isArray(target.title)) {
              targetTitle =
                target.title
                  .map((t) => t?.plain_text ?? "")
                  .join("")
                  .trim() || "Untitled";
            }
          } catch {
            /* fall through with default */
          }
          relations.push({
            sourceDbId: sourceId,
            sourceProp: propName,
            targetDbId,
            targetTitle,
            targetIsKnown: knownIds.has(targetDbId),
            targetRole: roleByNormId.get(stripDashes(targetDbId)) ?? null,
          });
        }
      }
      respond(true, { relations });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Persist a binding and (optionally) apply the additive schema patch
   * the operator approved. After the binding lands, kicks off a one-shot
   * pull so the freshly-imported rows show up in the kanban store
   * immediately rather than waiting on the next 60s tick.
   *
   * params:
   *   dbId: string (required)
   *   role: NotionRoleId (required)
   *   fieldMap: { [canonical]: notionPropertyName } (required)
   *   conflictPolicy?: "queue" | "last-write-wins" (default "queue")
   *   title?: string
   *   applyPatch?: boolean — if true, run additive PATCH to add missing
   *                          canonical props to Notion.
   *   customFields?: { [propId]: { name, type } }  — only meaningful for role="custom"
   */
  "notion.import.commit": async ({ params, respond }) => {
    const dbId = typeof params?.dbId === "string" ? params.dbId : "";
    const roleRaw = typeof params?.role === "string" ? params.role : "";
    if (!dbId || !roleRaw) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId and role required" });
      return;
    }
    if (!isRoleId(roleRaw)) {
      respond(false, undefined, { code: "BAD_REQUEST", message: `unknown role: ${roleRaw}` });
      return;
    }
    const role: NotionRoleId = roleRaw;

    const fieldMapRaw = (params?.fieldMap as Record<string, unknown> | undefined) ?? {};
    const fieldMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldMapRaw)) {
      if (typeof v === "string" && v) fieldMap[k] = v;
    }

    const conflictPolicy: ConflictPolicy =
      params?.conflictPolicy === "last-write-wins" ? "last-write-wins" : "queue";

    const customFields =
      role === "custom" && params?.customFields && typeof params.customFields === "object"
        ? (params.customFields as NotionBinding["customFields"])
        : undefined;

    try {
      // Optional: apply additive schema patch first so the binding's
      // field map references properties that actually exist on Notion.
      let patchResult: Awaited<ReturnType<typeof applySchemaPatch>> | null = null;
      if (params?.applyPatch === true && role !== "custom") {
        const canonicalRole = ROLES_BY_ID[role];
        if (canonicalRole) {
          const diff = await diffSchema(dbId, role);
          if (diff) {
            patchResult = await applySchemaPatch(dbId, canonicalRole, diff);
          }
        }
      }

      // Per-business scope (products / clients / leads imports kicked off
      // from a business-scoped page). When set, the poller writes rows into
      // the business's dedicated database via the system-role bridge so
      // they show up on that business's page; without it the rows would
      // land in the global role mapping and the per-business page would
      // never see them.
      const businessId =
        typeof params?.businessId === "string" && params.businessId.trim()
          ? params.businessId.trim()
          : null;
      const binding: NotionBinding = {
        notionDbId: dbId,
        role,
        fieldMap,
        customFields,
        lastSyncedAt: null,
        conflictPolicy,
        title: typeof params?.title === "string" ? params.title : null,
        businessId,
      };
      await upsertBinding(binding);

      // One-shot backfill so the user sees rows arrive in seconds.
      // `force: true` bypasses the periodic poller's syncMode === "off"
      // gate — operators who only want one-shot import (not background
      // sync) shouldn't have to flip syncMode just to see their rows.
      let pullResult: Awaited<ReturnType<typeof pollNotionNow>> | null = null;
      try {
        pullResult = await pollNotionNow({ force: true });
      } catch (err) {
        // Non-fatal: binding is saved, the periodic poller will catch up.
        log.warn("import commit: initial pull failed", { dbId, err: String(err) });
      }

      log.info("import commit", {
        dbId,
        role,
        conflictPolicy,
        applied: patchResult?.applied?.length ?? 0,
      });
      // Two post-write reads — the cached/synthesized view AND the raw
      // disk JSON. If they diverge, we know the cache or synthesis is
      // hiding the binding from the poller even though it's on disk.
      const postWriteCfg = getNotionConfig();
      const postWriteBindings = Object.entries(postWriteCfg.bindings ?? {}).map(([id, b]) => ({
        id,
        role: b.role,
        businessId: b.businessId ?? null,
      }));
      let diskBindings: Array<{ id: string; role: string; businessId: string | null }> = [];
      let postValidateBindings: Array<{ id: string; role: string; businessId: string | null }> = [];
      let validationDropped: string[] = [];
      try {
        const ioMod = await import("../../config/io.js");
        const snap = await ioMod.readConfigFileSnapshot();
        const parsedNotion = (
          snap.parsed as {
            notion?: { bindings?: Record<string, { role?: string; businessId?: string | null }> };
          } | null
        )?.notion;
        const diskBindMap = parsedNotion?.bindings ?? {};
        diskBindings = Object.entries(diskBindMap).map(([id, b]) => ({
          id,
          role: b.role ?? "?",
          businessId: b.businessId ?? null,
        }));
        // Run the exact schema validation that loadConfig uses, then compare
        // the binding set before and after. Anything in diskBindings but
        // missing from postValidateBindings was silently dropped by zod.
        const validationMod = await import("../../config/validation.js");
        const validated = validationMod.validateConfigObjectWithPlugins(snap.parsed);
        if (validated.ok) {
          const validatedBindMap =
            (
              validated.config as {
                notion?: {
                  bindings?: Record<string, { role?: string; businessId?: string | null }>;
                };
              }
            )?.notion?.bindings ?? {};
          postValidateBindings = Object.entries(validatedBindMap).map(([id, b]) => ({
            id,
            role: b.role ?? "?",
            businessId: b.businessId ?? null,
          }));
          const validIds = new Set(postValidateBindings.map((b) => b.id));
          validationDropped = diskBindings.map((b) => b.id).filter((id) => !validIds.has(id));
        } else {
          validationDropped = [
            `(validation failed: ${validated.issues
              .map((i) => `${i.path || "<root>"}: ${i.message}`)
              .join("; ")})`,
          ];
        }
      } catch (e) {
        log.warn("post-write disk read failed", { err: String(e) });
      }
      respond(true, {
        binding,
        patch: patchResult,
        initialPull: pullResult,
        _serverBuild: "products-applier-v5",
        _debug: {
          attemptedBinding: { role, businessId, dbId, fieldMap, conflictPolicy },
          postWriteBindings,
          diskBindings,
          postValidateBindings,
          validationDropped,
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Drop a binding so a Notion DB is no longer synced. Leaves the Notion
   * data alone; only removes the local binding record. The operator can
   * re-import later via the wizard.
   */
  "notion.import.unbind": async ({ params, respond }) => {
    const dbId = typeof params?.dbId === "string" ? params.dbId : "";
    if (!dbId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId required" });
      return;
    }
    try {
      const cfg = await removeBinding(dbId);
      respond(true, { ok: true, bindings: cfg.bindings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Force a re-pull of an existing binding without rebinding it. The
   * "Pull from Notion" buttons on the products / projects / notes /
   * clients pages call this so the operator can yank fresh data after
   * editing properties in Notion (or after the importer logic changes).
   *
   * Two scopes:
   *   - `params.dbId` — pull just that DB binding
   *   - omit `dbId` and pass `params.role` — pull every binding of that role
   *
   * Returns the pollNotionNow() result so the UI can show counts.
   */
  "notion.import.refresh": async ({ params, respond }) => {
    const dbId = typeof params?.dbId === "string" ? params.dbId : null;
    const role = typeof params?.role === "string" ? params.role : null;
    const businessId =
      typeof params?.businessId === "string" && params.businessId.trim()
        ? params.businessId.trim()
        : null;

    if (!dbId && !role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId or role required" });
      return;
    }

    try {
      const cfg = getNotionConfig();
      // Filter eligible bindings. When dbId is given, scope to that one;
      // when role is given (and optionally businessId), pull every
      // matching binding so a Projects page can refresh all its DBs in
      // one click.
      const matching = Object.values(cfg.bindings).filter((b) => {
        if (dbId && b.notionDbId !== dbId) return false;
        if (role && b.role !== role) return false;
        if (businessId && b.businessId && b.businessId !== businessId) return false;
        return true;
      });
      if (matching.length === 0) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "no matching binding to refresh",
        });
        return;
      }

      // Lazy-load to keep the import RPC handler module light.
      const { pollNotionNow } = await import("../../databases/notion-bidirectional-sync.js");
      const result = await pollNotionNow({ force: true });
      respond(true, {
        ok: true,
        refreshed: matching.map((b) => ({
          dbId: b.notionDbId,
          role: b.role,
          title: b.title,
          businessId: b.businessId ?? null,
        })),
        result,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Snapshot of every active binding — used by the wizard's "current bindings" panel. */
  "notion.import.listBindings": async ({ respond }) => {
    try {
      const cfg = getNotionConfig();
      respond(true, { bindings: Object.values(cfg.bindings) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Swap which Notion DB a role is bound to without dropping the role
   * itself. Used by the per-page "Change Notion DB" buttons. The old
   * binding (if specified) is removed; the new one inherits the role and
   * a fresh field map (proposed from the new DB's actual properties).
   *
   * Doesn't touch row data — call notion.import.findOverlaps + mergeRows
   * separately to reconcile rows between the two DBs.
   *
   * params:
   *   role: NotionRoleId (required) — which role to retarget
   *   newNotionDbId: string (required)
   *   oldNotionDbId?: string — if multiple bindings share the role, which
   *                            one to replace; otherwise the only one wins.
   *   conflictPolicy?: "queue" | "last-write-wins"
   *   keepOld?: boolean — when true, leave the old binding in place
   *                       (additive add). Default false (replace).
   */
  "notion.bindings.changeTarget": async ({ params, respond }) => {
    const role = typeof params?.role === "string" ? (params.role as NotionRoleId) : "";
    const newNotionDbId = typeof params?.newNotionDbId === "string" ? params.newNotionDbId : "";
    if (!role || !newNotionDbId) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "role and newNotionDbId required",
      });
      return;
    }
    try {
      const oldNotionDbId =
        typeof params?.oldNotionDbId === "string" ? params.oldNotionDbId : undefined;
      const conflictPolicy: ConflictPolicy =
        params?.conflictPolicy === "last-write-wins" ? "last-write-wins" : "queue";
      const keepOld = params?.keepOld === true;

      // Resolve which old binding(s) to drop. If oldNotionDbId is supplied,
      // use that; otherwise drop ALL existing bindings for this role except
      // the new target. Multiple bindings can accumulate when an earlier
      // swap landed before the canonical-id field was being kept in sync —
      // synthesizeLegacyBindings then re-creates a binding for the legacy
      // id on every config read, racing with the real binding. We don't
      // want that ambiguity to block subsequent swaps; the new id is the
      // single source of truth from this call onward.
      const existing = getBindingsByRole(role);
      const toRemoveList: string[] = oldNotionDbId
        ? [oldNotionDbId]
        : existing.map((b) => b.notionDbId).filter((id) => id !== newNotionDbId);

      // Propose a field map by reading the new DB's schema and matching
      // canonical aliases. Operator can refine via the wizard later.
      let fieldMap: Record<string, string> = {};
      const canonicalRole = role !== "custom" ? ROLES_BY_ID[role] : null;
      const schema = await getDatabaseSchema(newNotionDbId, { force: true });
      if (canonicalRole && schema) {
        const namesLower = new Map(
          Array.from(schema.byName.keys()).map((n) => [n.toLowerCase(), n]),
        );
        for (const prop of canonicalRole.properties) {
          for (const alias of prop.aliases) {
            const found = namesLower.get(alias.toLowerCase());
            if (found) {
              fieldMap[prop.canonical] = found;
              break;
            }
          }
        }
      } else if (schema) {
        for (const n of schema.byName.keys()) fieldMap[n] = n;
      }

      const newBinding: NotionBinding = {
        notionDbId: newNotionDbId,
        role,
        fieldMap,
        lastSyncedAt: null,
        conflictPolicy,
        title: null,
      };
      await upsertBinding(newBinding);

      const removed: string[] = [];
      if (!keepOld) {
        for (const id of toRemoveList) {
          if (!id || id === newNotionDbId) continue;
          await removeBinding(id);
          removed.push(id);
        }
      }

      // Bindings alone aren't enough — `resolveNotionDbId` (the source of
      // truth for kanban-bridge → /projects rendering) reads the legacy
      // canonical id fields (cfg.projectsDbId, tasksDbId, clientsDbId, …),
      // not the bindings map. Without this update the UI keeps rendering
      // the *previous* Notion DB even after a successful swap. Map the role
      // back to its canonical field and persist.
      const canonicalIdField: Partial<Record<string, string>> = {
        projects: "projectsDbId",
        tasks: "tasksDbId",
        clients: "clientsDbId",
        leads: "leadsDbId",
        companies: "companiesDbId",
        deals: "dealsDbId",
        contacts: "contactsDbId",
      };
      const canonicalKey = canonicalIdField[role];
      if (canonicalKey) {
        await writeNotionConfig({ [canonicalKey]: newNotionDbId });
      }

      // Drop the kanban-adapter's per-source cache so the UI's next
      // db.rows.list / projects-dashboard query sees rows from the new
      // Notion DB instead of stale cached entries from the old one.
      try {
        const { invalidateKanbanCache } = await import("../../databases/kanban-adapter.js");
        if (role === "projects") invalidateKanbanCache("kanban-projects");
        else if (role === "tasks") invalidateKanbanCache("kanban-tasks");
        else invalidateKanbanCache();
      } catch {
        // Adapter not available in this build path — non-fatal.
      }

      // Rename the local stub database (kanban-projects / kanban-tasks for
      // canonical roles, or the role-bound native DB for everything else)
      // to match the bound Notion DB's title — that's what the operator
      // sees in the sidebar and system-DBs card. Without this the stub
      // keeps its hardcoded "Projects" / "Tasks" / role label even after
      // the rebind, hiding which Notion DB is actually live.
      const newNotionDbTitle =
        typeof params?.newNotionDbTitle === "string" ? params.newNotionDbTitle.trim() : "";
      if (newNotionDbTitle) {
        try {
          const { getDatabasesStore } = await import("../../databases/store.js");
          const { STATE_DIR } = await import("../../config/paths.js");
          const dbStore = getDatabasesStore();
          let targetDbId: string | null = null;
          if (role === "projects") {
            targetDbId = dbStore.getDatabaseBySource("kanban-projects")?.id ?? null;
          } else if (role === "tasks") {
            targetDbId = dbStore.getDatabaseBySource("kanban-tasks")?.id ?? null;
          } else if (role !== "custom") {
            // Generic role (clients/leads/companies/deals/contacts) →
            // look up via system role mapping.
            const { SYSTEM_ROLES } = await import("../../databases/types.js");
            if ((SYSTEM_ROLES as readonly string[]).includes(role)) {
              const resolved = dbStore.resolveSystemRole(
                role as Parameters<typeof dbStore.resolveSystemRole>[0],
              );
              targetDbId = resolved?.database.id ?? null;
            }
          }
          if (targetDbId) {
            dbStore.updateDatabase(targetDbId, { name: newNotionDbTitle });
          }
        } catch (err) {
          log.warn("could not rename stub to Notion title", { err: String(err) });
        }
      }

      log.info("binding retargeted", {
        role,
        removed,
        newNotionDbId,
        keepOld,
      });
      respond(true, {
        binding: newBinding,
        // Backwards-compat: callers that only checked `replaced` get the
        // first removed id. New `replacedAll` exposes everything that was
        // dropped to clean up multi-binding states left over from earlier
        // partial swaps.
        replaced: removed[0] ?? null,
        replacedAll: removed,
        keptOld: keepOld,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Compare rows in the new Notion DB against existing local rows for
   * the role. Match by case-insensitive normalized title — cheap, fairly
   * reliable, and the only signal that doesn't require a hand-coded
   * matcher per role.
   *
   * Returns three arrays the swap modal renders:
   *   - overlaps: pairs the operator must resolve (keep-local / keep-notion / merge)
   *   - notionOnly: rows that exist on Notion but not locally (would be
   *                 imported as new local rows on the next pull)
   *   - localOnly: rows that exist locally but not on Notion (would be
   *                pushed as new Notion pages on the next sync)
   *
   * Caps at 500 Notion pages by default to bound the round-trip cost.
   */
  "notion.import.findOverlaps": async ({ params, respond }) => {
    const notionDbId = typeof params?.notionDbId === "string" ? params.notionDbId : "";
    const role = typeof params?.role === "string" ? (params.role as NotionRoleId) : "";
    if (!notionDbId || !role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "notionDbId and role required" });
      return;
    }
    const apiKey = getNotionApiKeyForImport();
    if (!apiKey) {
      respond(false, undefined, { code: "NOT_CONFIGURED", message: "Notion not configured" });
      return;
    }
    const maxPages = typeof params?.maxPages === "number" ? Math.min(params.maxPages, 1000) : 500;

    try {
      // Pull pages from the new Notion DB.
      const pages: Array<{
        id: string;
        title: string;
        lastEditedTime?: string;
        archived?: boolean;
      }> = [];
      let cursor: string | undefined;
      while (pages.length < maxPages) {
        const body: Record<string, unknown> = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const res = (await fetch(`${NOTION_API_URL}/databases/${notionDbId}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        }).then((r) => r.json())) as {
          results?: Array<{
            id: string;
            archived?: boolean;
            last_edited_time?: string;
            properties?: Record<string, any>;
          }>;
          has_more?: boolean;
          next_cursor?: string;
        };
        for (const p of res.results ?? []) {
          let title = "";
          for (const v of Object.values(p.properties ?? {})) {
            const prop = v as { type?: string; title?: Array<{ plain_text?: string }> };
            if (prop?.type === "title" && Array.isArray(prop.title)) {
              title = prop.title
                .map((t) => t?.plain_text ?? "")
                .join("")
                .trim();
              break;
            }
          }
          pages.push({ id: p.id, title, lastEditedTime: p.last_edited_time, archived: p.archived });
        }
        if (!res.has_more || !res.next_cursor) break;
        cursor = res.next_cursor;
      }

      // Local rows for the role. Currently only projects/tasks have a
      // store; CRM matching returns empty until those stores are wired.
      const localRows = await loadLocalRowsForRole(role);

      // ── Fuzzy matching ──
      // Three tiers, each with a fixed score so the UI can sort by
      // confidence:
      //   1.00  exact normalized equality (whitespace/case folded)
      //   0.85  one side fully contains the other after normalization —
      //         catches "Acme" vs "Acme Co." and similar truncations
      //   ≥0.70 Levenshtein-similarity above the threshold; the score is
      //         the similarity itself, so weak matches sort last
      //
      // Greedy assignment: each Notion page picks its single best local
      // match; if two Notion pages claim the same local row the higher-
      // score one wins and the loser drops to notionOnly. Avoids the
      // common "everything matches the catch-all 'New Project' row".
      const overlaps: Array<{
        notionPageId: string;
        notionTitle: string;
        notionArchived: boolean;
        localRowId: string;
        localTitle: string;
        matchScore: number;
        matchReason: string;
      }> = [];
      const notionOnly: Array<{ notionPageId: string; notionTitle: string }> = [];

      // Per-local-id: best claim seen so far. Used to evict losers when
      // a higher-score Notion candidate claims the same local row.
      const bestByLocal = new Map<
        string,
        { overlapIndex: number; notionPageId: string; matchScore: number }
      >();

      for (const page of pages) {
        if (!page.title) {
          notionOnly.push({ notionPageId: page.id, notionTitle: "(untitled)" });
          continue;
        }
        const candidate = bestFuzzyMatch(page.title, localRows);
        if (!candidate) {
          notionOnly.push({ notionPageId: page.id, notionTitle: page.title });
          continue;
        }
        const incumbent = bestByLocal.get(candidate.row.id);
        if (incumbent) {
          if (candidate.score <= incumbent.matchScore) {
            // Loser — Notion page didn't win the contested local row.
            notionOnly.push({ notionPageId: page.id, notionTitle: page.title });
            continue;
          }
          // Evict the previous claimant; convert to notionOnly.
          const evicted = overlaps[incumbent.overlapIndex];
          notionOnly.push({ notionPageId: evicted.notionPageId, notionTitle: evicted.notionTitle });
          // Repurpose the slot for the new winner so we don't realloc.
          overlaps[incumbent.overlapIndex] = {
            notionPageId: page.id,
            notionTitle: page.title,
            notionArchived: page.archived === true,
            localRowId: candidate.row.id,
            localTitle: candidate.row.title,
            matchScore: candidate.score,
            matchReason: candidate.reason,
          };
          bestByLocal.set(candidate.row.id, {
            overlapIndex: incumbent.overlapIndex,
            notionPageId: page.id,
            matchScore: candidate.score,
          });
          continue;
        }
        const idx = overlaps.length;
        overlaps.push({
          notionPageId: page.id,
          notionTitle: page.title,
          notionArchived: page.archived === true,
          localRowId: candidate.row.id,
          localTitle: candidate.row.title,
          matchScore: candidate.score,
          matchReason: candidate.reason,
        });
        bestByLocal.set(candidate.row.id, {
          overlapIndex: idx,
          notionPageId: page.id,
          matchScore: candidate.score,
        });
      }
      // Sort overlaps by score desc so the operator sees high-confidence
      // matches first; the UI doesn't have to do this itself.
      overlaps.sort((a, b) => b.matchScore - a.matchScore);

      const matchedLocalIds = new Set(overlaps.map((o) => o.localRowId));
      const localOnly = localRows
        .filter((r) => !matchedLocalIds.has(r.id))
        .map((r) => ({ localRowId: r.id, localTitle: r.title }));

      respond(true, {
        notionDbId,
        role,
        notionPageCount: pages.length,
        localRowCount: localRows.length,
        overlaps,
        notionOnly,
        localOnly,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Apply a merge plan produced by the swap modal. For each item:
   *   - keep-local: link the local row to the Notion page (set
   *                 notionPageId), then overwrite Notion's properties
   *                 with the local row's values on next sync push.
   *   - keep-notion: link the local row to the Notion page; the next
   *                  pull cycle overwrites local with Notion's values.
   *   - merge: just link the rows. Field-by-field merge is deferred to
   *            the conflict queue, which will surface the diff on the
   *            next poll cycle.
   *
   * Linking is the load-bearing operation: once notionPageId is set on
   * the local row, the bidirectional poller's existing logic takes over.
   */
  "notion.import.mergeRows": async ({ params, respond }) => {
    const planRaw = Array.isArray(params?.plan) ? params.plan : [];
    const role = typeof params?.role === "string" ? params.role : "";
    if (!role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "role required" });
      return;
    }
    if (planRaw.length === 0) {
      respond(true, { applied: 0 });
      return;
    }
    if (role !== "projects" && role !== "tasks" && role !== "clients") {
      // Leads/companies/deals/contacts don't have row collections in
      // state yet (only schema / Notion DB ids). Gate explicitly so
      // callers don't think they applied a plan that secretly no-op'd.
      respond(false, undefined, {
        code: "ROLE_UNSUPPORTED",
        message: `mergeRows supports projects, tasks, and clients today (got "${role}")`,
      });
      return;
    }

    try {
      let applied = 0;

      if (role === "clients") {
        const linker = await getCrmLinker(role);
        if (!linker) {
          respond(false, undefined, {
            code: "CRM_UNAVAILABLE",
            message: `no CRM persistence for role "${role}"`,
          });
          return;
        }
        for (const itemRaw of planRaw) {
          const item = itemRaw as {
            notionPageId?: string;
            localRowId?: string;
            action?: "keep-local" | "keep-notion" | "merge";
          };
          if (!item.notionPageId || !item.localRowId || !item.action) continue;
          if (linker.setNotionPageId(item.localRowId, item.notionPageId)) {
            applied++;
          }
        }
      } else {
        const { getKanbanStore } = await import("../../tasks/store.js");
        const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
        const store = getKanbanStore(stateDir);
        const table: "projects" | "tasks" = role;

        for (const itemRaw of planRaw) {
          const item = itemRaw as {
            notionPageId?: string;
            localRowId?: string;
            action?: "keep-local" | "keep-notion" | "merge";
          };
          if (!item.notionPageId || !item.localRowId || !item.action) continue;
          if (store.setNotionPageId) {
            store.setNotionPageId(table, item.localRowId, item.notionPageId);
            applied++;
          }
        }
      }
      // Property propagation happens on the next bidirectional poll. For
      // "keep-local" the push side handles it; for "keep-notion" and
      // "merge", the next pull resolves what to take. mergeRows is
      // link-only by design — sync + conflict machinery does field work.
      respond(true, { applied });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

/**
 * Load every local row for the given role with a uniform shape:
 *   { id, title, updatedAt? }
 *
 * Lazy-imports the kanban store / CRM persistence to keep this gateway
 * file loadable in contexts (CLI helpers, tests) that don't have the
 * downstream stores available.
 */
async function loadLocalRowsForRole(
  role: NotionRoleId,
): Promise<Array<{ id: string; title: string; updatedAt?: number }>> {
  if (role === "projects" || role === "tasks") {
    const { getKanbanStore } = await import("../../tasks/store.js");
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const store = getKanbanStore(stateDir);
    if (role === "projects") {
      const projects = (await store.getProjects()) as Array<{
        id: string;
        name?: string;
        updatedAt?: number;
      }>;
      return projects.map((p) => ({ id: p.id, title: p.name ?? "", updatedAt: p.updatedAt }));
    }
    const tasks = (await store.getTasks()) as Array<{
      id: string;
      title?: string;
      updatedAt?: number;
    }>;
    return tasks.map((t) => ({ id: t.id, title: t.title ?? "", updatedAt: t.updatedAt }));
  }
  if (role === "clients") {
    const linker = await getCrmLinker("clients");
    return linker?.list() ?? [];
  }
  // Leads/companies/deals/contacts don't have local row collections yet;
  // the wizard's overlap step will show "0 local rows" until those
  // stores are wired (notion-only and local-only sides still work).
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// Fuzzy title matching
// ─────────────────────────────────────────────────────────────────────────

/** Normalize for matching: lowercase, collapse whitespace, strip punctuation noise. */
function normalizeTitle(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[._'"`]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Iterative two-row Levenshtein distance. O(n*m) time, O(min(n,m)) space.
 * Bounded internally by an early exit when both strings are short enough
 * that allocating the work matters less than the function-call overhead.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Make `b` the shorter one to keep the working row small.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const prev = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) prev[i] = i;
  for (let i = 1; i <= a.length; i++) {
    let curr = i;
    let prevDiag = i - 1;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const above = prev[j];
      const left = curr;
      curr = Math.min(above + 1, left + 1, prevDiag + cost);
      prev[j - 1] = left;
      prevDiag = above;
    }
    prev[b.length] = curr;
  }
  return prev[b.length];
}

/** 0..1 similarity from Levenshtein distance over the longer string. */
function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - levenshtein(a, b) / longer;
}

const FUZZY_THRESHOLD = 0.7;

/**
 * Best fuzzy match for a Notion title against a list of local rows. Returns
 * null when nothing crosses the threshold. Scoring:
 *   - exact normalized equality          → 1.00, "title-exact"
 *   - one fully contains the other       → 0.85, "title-substring"
 *   - similarity above 0.70              → similarity, "title-fuzzy"
 *
 * Ties broken by `updatedAt` desc (we prefer linking to the most recently
 * touched local row when several match equally well).
 */
function bestFuzzyMatch(
  notionTitle: string,
  localRows: Array<{ id: string; title: string; updatedAt?: number }>,
): {
  row: { id: string; title: string; updatedAt?: number };
  score: number;
  reason: string;
} | null {
  const a = normalizeTitle(notionTitle);
  if (!a) return null;
  let best: {
    row: { id: string; title: string; updatedAt?: number };
    score: number;
    reason: string;
  } | null = null;

  for (const row of localRows) {
    const b = normalizeTitle(row.title);
    if (!b) continue;
    let score = 0;
    let reason = "";
    if (a === b) {
      score = 1;
      reason = "title-exact";
    } else if (a.includes(b) || b.includes(a)) {
      score = 0.85;
      reason = "title-substring";
    } else {
      // Skip the Levenshtein cost when the lengths differ wildly — strings
      // that differ by more than the threshold-allowed edits can't pass.
      const longer = Math.max(a.length, b.length);
      const maxAllowedEdits = Math.floor(longer * (1 - FUZZY_THRESHOLD));
      if (Math.abs(a.length - b.length) > maxAllowedEdits) continue;
      const sim = similarity(a, b);
      if (sim < FUZZY_THRESHOLD) continue;
      score = sim;
      reason = "title-fuzzy";
    }
    if (
      !best ||
      score > best.score ||
      (score === best.score && (row.updatedAt ?? 0) > (best.row.updatedAt ?? 0))
    ) {
      best = { row, score, reason };
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// CRM persistence linker — minimal shim over business.json
// ─────────────────────────────────────────────────────────────────────────

interface CrmLinker {
  /** Uniform row shape for overlap matching. */
  list(): Array<{ id: string; title: string; updatedAt?: number }>;
  /** Set notion_page_id on a record by id; returns true if it landed. */
  setNotionPageId(localRowId: string, notionPageId: string): boolean;
}

/**
 * Returns a tiny linker for CRM persistence so mergeRows can wire a
 * Notion page id onto an existing CRM record without coupling to the
 * gateway/business.ts module shape. Today only "clients" has a row
 * collection in state/business.json; the others are placeholders.
 */
async function getCrmLinker(role: NotionRoleId): Promise<CrmLinker | null> {
  if (role !== "clients") return null;
  const fs = await import("fs");
  const path = await import("path");
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  const filePath = path.join(stateDir, "business.json");

  const readFile = (): { clients?: Array<Record<string, unknown>> } & Record<string, unknown> => {
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return {};
    }
  };

  // Per-business CRM split: clients live on each BusinessProfile.clients
  // array now. The linker aggregates across every business so notion-import
  // can keep treating "clients" as one role without knowing which business
  // owns each row. The legacy global `state.clients` is read as a fallback
  // for installs that haven't been migrated yet.
  type RawRow = Record<string, unknown>;
  const collectRecords = (state: {
    clients?: RawRow[];
    businesses?: Array<Record<string, unknown>>;
  }): RawRow[] => {
    const out: RawRow[] = [];
    if (Array.isArray(state.businesses)) {
      for (const b of state.businesses) {
        const arr = (b as Record<string, unknown>).clients;
        if (Array.isArray(arr))
          for (const r of arr) if (r && typeof r === "object") out.push(r as RawRow);
      }
    }
    if (out.length === 0 && Array.isArray(state.clients)) {
      for (const r of state.clients) if (r && typeof r === "object") out.push(r as RawRow);
    }
    return out;
  };

  return {
    list: () => {
      const state = readFile();
      const records = collectRecords(state);
      // Build imperatively so the optional `updatedAt` stays optional —
      // returning `{ updatedAt: number | undefined }` from a map step
      // tightens the type to "required key, may be undefined" which TS
      // (under strict) won't widen back to the optional shape the
      // CrmLinker.list() return type expects.
      const out: Array<{ id: string; title: string; updatedAt?: number }> = [];
      for (const r of records) {
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) continue;
        const data = (
          r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {}
        ) as Record<string, unknown>;
        const title =
          pickStringField(data, [
            "Name",
            "Client",
            "Title",
            "Full Name",
            "name",
            "client",
            "title",
          ]) || id;
        const updatedAt = parseDateMs(r.updated_at ?? r.updatedAt);
        const entry: { id: string; title: string; updatedAt?: number } = { id, title };
        if (updatedAt !== undefined) entry.updatedAt = updatedAt;
        out.push(entry);
      }
      return out;
    },
    setNotionPageId: (localRowId, notionPageId) => {
      const state = readFile();
      // Walk per-business arrays first, then the legacy global bucket.
      const stamp = new Date().toISOString();
      let touched = false;
      if (Array.isArray(state.businesses)) {
        for (const biz of state.businesses) {
          const arr = (biz as Record<string, unknown>).clients;
          if (!Array.isArray(arr)) continue;
          const idx = arr.findIndex((r) => (r as Record<string, unknown>).id === localRowId);
          if (idx === -1) continue;
          arr[idx] = { ...(arr[idx] as object), notion_page_id: notionPageId, updated_at: stamp };
          (biz as Record<string, unknown>).updatedAt = stamp;
          touched = true;
          break;
        }
      }
      if (!touched && Array.isArray(state.clients)) {
        const idx = state.clients.findIndex(
          (r) => (r as Record<string, unknown>).id === localRowId,
        );
        if (idx !== -1) {
          state.clients[idx] = {
            ...(state.clients[idx] as object),
            notion_page_id: notionPageId,
            updated_at: stamp,
          };
          touched = true;
        }
      }
      if (!touched) return false;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function pickStringField(data: Record<string, unknown>, names: string[]): string {
  for (const n of names) {
    const v = data[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function parseDateMs(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

// Quiet unused-import warning if helpers shift in future refactors.
void getAllBindings;

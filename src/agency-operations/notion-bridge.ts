import { getNotionApiKeyForImport } from "../databases/notion-config.js";
import type { AgencyOperationsStore } from "./store.js";
import type { AgencyProjectStatus, AgencyTaskStatus } from "./types.js";
import type {
  ExternalEntityType,
  ExternalProviderBinding,
  ExternalSyncDirection,
} from "./external-links.js";
import { classifyDrift, hashAgencyEntity, hashExternalPayload } from "./external-links.js";

/**
 * Notion as a *mirror* of agency.db.
 *
 * The legacy `business.clients.notion.*` handlers treated Notion as the store
 * and business.json as a cache of it. This module inverts that: agency.db is
 * the record, Notion is one linked provider, and every write is gated on the
 * drift verdict from `external_entity_links`. A record whose local and remote
 * hashes both match their last-sync baselines is skipped entirely — no Notion
 * call, no database write.
 *
 * The transport is injectable so the sync logic is testable without touching
 * the network; production code gets the real one from `createNotionTransport`.
 */

export const NOTION_PROVIDER = "notion";
const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionTransport {
  request(path: string, init?: { method?: string; body?: unknown }): Promise<any>;
}

/**
 * Reuses the shared Notion credential resolution from `databases/notion-config`
 * (env var first, then the wizard-stored key) rather than reading
 * `process.env` directly, so the agency mirror sees the same workspace the
 * rest of the product does. The token is never persisted into agency.db.
 */
export function createNotionTransport(apiKey?: string | null): NotionTransport {
  const key = apiKey ?? getNotionApiKeyForImport();
  if (!key) throw new Error("Notion is not configured");
  return {
    async request(path, init) {
      const res = await fetch(`${NOTION_API_URL}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new Error(`Notion ${res.status}: ${body?.message ?? text.slice(0, 200)}`);
      }
      return body;
    },
  };
}

// ── Schema + property mapping ──────────────────────────────────────────────

export interface NotionDatabaseMeta {
  id: string;
  name: string;
  url: string | null;
  properties: Record<string, string>;
  titleProperty: string | null;
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((item: any) => (typeof item?.plain_text === "string" ? item.plain_text : ""))
    .join("")
    .trim();
}

export function toNotionDatabaseMeta(db: any): NotionDatabaseMeta {
  const properties: Record<string, string> = {};
  let titleProperty: string | null = null;
  for (const [name, def] of Object.entries((db?.properties ?? {}) as Record<string, any>)) {
    const type = typeof def?.type === "string" ? def.type : "";
    properties[name] = type;
    if (type === "title" && !titleProperty) titleProperty = name;
  }
  return {
    id: String(db?.id ?? ""),
    name: plainText(db?.title) || "Untitled",
    url: typeof db?.url === "string" ? db.url : null,
    properties,
    titleProperty,
  };
}

export async function fetchNotionDatabaseMeta(
  transport: NotionTransport,
  databaseId: string,
): Promise<NotionDatabaseMeta> {
  return toNotionDatabaseMeta(await transport.request(`/databases/${databaseId}`));
}

export async function listNotionDatabases(
  transport: NotionTransport,
  limit = 50,
): Promise<Array<{ id: string; name: string; url: string | null }>> {
  const body = await transport.request("/search", {
    method: "POST",
    body: {
      filter: { value: "database", property: "object" },
      page_size: Math.max(1, Math.min(100, Math.trunc(limit))),
    },
  });
  return ((body?.results ?? []) as any[]).map((db) => {
    const meta = toNotionDatabaseMeta(db);
    return { id: meta.id, name: meta.name, url: meta.url };
  });
}

export async function queryNotionPages(
  transport: NotionTransport,
  databaseId: string,
  limit = 500,
): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;
  while (pages.length < limit) {
    const body = await transport.request(`/databases/${databaseId}/query`, {
      method: "POST",
      body: {
        page_size: Math.min(100, limit - pages.length),
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
    pages.push(...((body?.results ?? []) as any[]));
    if (!body?.has_more || typeof body?.next_cursor !== "string") break;
    cursor = body.next_cursor;
  }
  return pages;
}

/**
 * Canonical field → the Notion property names we are willing to bind it to,
 * most specific first. Matching is case-insensitive so "due date", "Due Date"
 * and "DUE DATE" all resolve to the same column.
 */
const FIELD_ALIASES: Record<ExternalEntityType, Record<string, string[]>> = {
  client: {
    name: ["Name", "Client", "Client Name", "Company", "Title"],
    status: ["Status", "Stage"],
    billingEmail: ["Billing Email", "Email"],
    notes: ["Notes", "Description"],
  },
  project: {
    name: ["Name", "Project", "Project Name", "Title"],
    status: ["Status", "Stage"],
    budget: ["Budget", "Value", "Amount"],
    targetEndAt: ["Target End", "Due Date", "Due", "End Date", "Deadline"],
  },
  task: {
    title: ["Name", "Task", "Task Name", "Title"],
    status: ["Status", "Stage"],
    priority: ["Priority"],
    description: ["Description", "Notes", "Details"],
    dueAt: ["Due Date", "Due", "Deadline"],
  },
  invoice: {
    number: ["Name", "Invoice Number", "Invoice", "Number", "Title"],
    status: ["Status"],
    total: ["Total", "Amount", "Total Amount"],
    amountPaid: ["Paid", "Amount Paid"],
    currency: ["Currency"],
    dueAt: ["Due Date", "Due"],
  },
};

function resolveProperty(meta: NotionDatabaseMeta, aliases: string[]): string | null {
  const byLower = new Map(
    Object.keys(meta.properties).map((name) => [name.toLowerCase(), name] as const),
  );
  for (const alias of aliases) {
    const match = byLower.get(alias.toLowerCase());
    if (match) return match;
  }
  return null;
}

/** field → actual Notion property name, for one bound database. */
export function buildFieldMap(
  entityType: ExternalEntityType,
  meta: NotionDatabaseMeta,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES[entityType])) {
    const resolved = resolveProperty(meta, aliases);
    if (resolved) map[field] = resolved;
  }
  // The title column is mandatory in Notion; fall back to it for the name-ish
  // field so a database with an oddly-named title still round-trips.
  const nameField = entityType === "task" ? "title" : entityType === "invoice" ? "number" : "name";
  if (!map[nameField] && meta.titleProperty) map[nameField] = meta.titleProperty;
  return map;
}

function readProperty(page: any, propertyName: string | undefined): unknown {
  if (!propertyName) return null;
  const prop = page?.properties?.[propertyName];
  if (!prop || typeof prop !== "object") return null;
  switch (prop.type) {
    case "title":
      return plainText(prop.title);
    case "rich_text":
      return plainText(prop.rich_text);
    case "email":
      return typeof prop.email === "string" ? prop.email : null;
    case "phone_number":
      return typeof prop.phone_number === "string" ? prop.phone_number : null;
    case "url":
      return typeof prop.url === "string" ? prop.url : null;
    case "number":
      return typeof prop.number === "number" ? prop.number : null;
    case "checkbox":
      return Boolean(prop.checkbox);
    case "select":
      return typeof prop.select?.name === "string" ? prop.select.name : null;
    case "status":
      return typeof prop.status?.name === "string" ? prop.status.name : null;
    case "multi_select":
      return ((prop.multi_select ?? []) as any[]).map((option) => option?.name).filter(Boolean);
    case "date": {
      const start = prop.date?.start;
      if (typeof start !== "string") return null;
      const parsed = Date.parse(start);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "formula":
      return prop.formula?.string ?? prop.formula?.number ?? null;
    default:
      return null;
  }
}

/**
 * The remote projection: exactly the fields this mirror understands, read out
 * of a Notion page. Hashed independently of the local projection — the two are
 * never compared to each other, only each to its own last-sync baseline.
 */
export function readRemoteEntity(
  entityType: ExternalEntityType,
  page: any,
  fieldMap: Record<string, string>,
): { fields: Record<string, unknown>; hash: string } {
  const fields: Record<string, unknown> = {};
  for (const field of Object.keys(FIELD_ALIASES[entityType])) {
    fields[field] = readProperty(page, fieldMap[field]);
  }
  return { fields, hash: hashExternalPayload(fields) };
}

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, " ")
    : "";
}

const STATUS_MAPS: Record<ExternalEntityType, Record<string, string>> = {
  client: {
    lead: "prospect",
    prospect: "prospect",
    qualified: "prospect",
    active: "active",
    client: "active",
    won: "active",
    inactive: "inactive",
    churned: "inactive",
    archived: "inactive",
    lost: "inactive",
  },
  project: {
    "not started": "planned",
    planned: "planned",
    backlog: "planned",
    todo: "planned",
    active: "active",
    "in progress": "active",
    doing: "active",
    "on hold": "on_hold",
    paused: "on_hold",
    blocked: "on_hold",
    done: "completed",
    complete: "completed",
    completed: "completed",
    shipped: "completed",
    cancelled: "cancelled",
    canceled: "cancelled",
  },
  task: {
    backlog: "backlog",
    "not started": "backlog",
    todo: "ready",
    ready: "ready",
    "in progress": "in_progress",
    doing: "in_progress",
    active: "in_progress",
    blocked: "blocked",
    review: "review",
    "in review": "review",
    done: "done",
    complete: "done",
    completed: "done",
    cancelled: "cancelled",
    canceled: "cancelled",
  },
  invoice: {
    draft: "draft",
    issued: "issued",
    sent: "issued",
    "partially paid": "partially_paid",
    overdue: "overdue",
    paid: "paid",
    void: "void",
  },
};

export function mapRemoteStatus(entityType: ExternalEntityType, value: unknown): string | null {
  return STATUS_MAPS[entityType][normalize(value)] ?? null;
}

function toCents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function writeProperty(type: string, value: unknown): Record<string, unknown> | null {
  switch (type) {
    case "title":
      return { title: [{ type: "text", text: { content: String(value ?? "").slice(0, 2000) } }] };
    case "rich_text":
      return {
        rich_text: value ? [{ type: "text", text: { content: String(value).slice(0, 2000) } }] : [],
      };
    case "email":
      return { email: value ? String(value) : null };
    case "number":
      return { number: typeof value === "number" && Number.isFinite(value) ? value : null };
    case "select":
      return { select: value ? { name: String(value) } : null };
    case "status":
      return { status: value ? { name: String(value) } : null };
    case "date":
      return {
        date:
          typeof value === "number" && Number.isFinite(value)
            ? { start: new Date(value).toISOString().slice(0, 10) }
            : null,
      };
    case "url":
      return { url: value ? String(value) : null };
    default:
      return null;
  }
}

/** Local entity → Notion property payload, restricted to bound properties. */
export function buildNotionProperties(
  entityType: ExternalEntityType,
  entity: Record<string, unknown>,
  meta: NotionDatabaseMeta,
  fieldMap: Record<string, string>,
): Record<string, unknown> {
  const source: Record<string, unknown> = (() => {
    switch (entityType) {
      case "client":
        return {
          name: entity.name,
          status: entity.status,
          billingEmail: entity.billingEmail,
          notes: entity.notes,
        };
      case "project":
        return {
          name: entity.name,
          status: entity.status,
          budget: typeof entity.budgetCents === "number" ? entity.budgetCents / 100 : null,
          targetEndAt: entity.targetEndAt,
        };
      case "task":
        return {
          title: entity.title,
          status: entity.status,
          priority: entity.priority,
          description: entity.description,
          dueAt: entity.dueAt,
        };
      case "invoice":
        return {
          number: entity.number,
          status: entity.status,
          total: typeof entity.totalCents === "number" ? entity.totalCents / 100 : null,
          amountPaid:
            typeof entity.amountPaidCents === "number" ? entity.amountPaidCents / 100 : null,
          currency: entity.currency,
          dueAt: entity.dueAt,
        };
    }
  })();
  const properties: Record<string, unknown> = {};
  for (const [field, propertyName] of Object.entries(fieldMap)) {
    const type = meta.properties[propertyName];
    if (!type) continue;
    const payload = writeProperty(type, source[field] ?? null);
    if (payload) properties[propertyName] = payload;
  }
  return properties;
}

// ── Orchestration ──────────────────────────────────────────────────────────

export interface AgencyNotionSyncReport {
  entityType: ExternalEntityType;
  databaseId: string;
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  errors: string[];
}

function emptyReport(entityType: ExternalEntityType, databaseId: string): AgencyNotionSyncReport {
  return {
    entityType,
    databaseId,
    scanned: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    errors: [],
  };
}

/**
 * A run that changed nothing must not stamp the binding either. The timestamp
 * looks harmless, but it lands in a replicated table, so a UI polling sync
 * every few seconds would rewrite the agency's replication digest forever and
 * keep every federated peer permanently "pending". The first run is stamped so
 * the UI can distinguish "checked, all clean" from "never connected"; after
 * that only real work moves the clock.
 */
function shouldStampBinding(report: AgencyNotionSyncReport, previous: number | null): boolean {
  if (previous === null) return true;
  return (
    report.created > 0 || report.updated > 0 || report.conflicts > 0 || report.errors.length > 0
  );
}

function requireBinding(
  store: AgencyOperationsStore,
  agencyId: string,
  entityType: ExternalEntityType,
): ExternalProviderBinding {
  const binding = store.getExternalBinding(agencyId, NOTION_PROVIDER, entityType);
  if (!binding) throw new Error(`no Notion database is connected for ${entityType}`);
  return binding;
}

/** Connect (or repoint) a Notion database to one agency entity type. */
export async function connectAgencyNotionDatabase(
  store: AgencyOperationsStore,
  input: {
    agencyId: string;
    entityType: ExternalEntityType;
    databaseId: string;
    databaseName?: string | null;
    syncDirection?: ExternalSyncDirection;
    actorId?: string;
  },
  transport: NotionTransport,
): Promise<{ binding: ExternalProviderBinding; changed: boolean; meta: NotionDatabaseMeta }> {
  const meta = await fetchNotionDatabaseMeta(transport, input.databaseId);
  const result = store.upsertExternalBinding(
    {
      agencyId: input.agencyId,
      provider: NOTION_PROVIDER,
      entityType: input.entityType,
      externalDatabaseId: meta.id || input.databaseId,
      externalDatabaseName: input.databaseName ?? meta.name,
      schema: {
        properties: meta.properties,
        titleProperty: meta.titleProperty,
        fieldMap: buildFieldMap(input.entityType, meta),
      },
      syncDirection: input.syncDirection,
    },
    input.actorId,
  );
  return { ...result, meta };
}

/**
 * Pull: Notion → agency.db. A page whose remote hash still matches the stored
 * baseline is skipped without touching the database. A page that changed while
 * the local row also changed is flagged `conflict` and left alone — the
 * operator decides, we never silently clobber the source of truth.
 */
export async function pullAgencyEntitiesFromNotion(
  store: AgencyOperationsStore,
  input: {
    agencyId: string;
    entityType: ExternalEntityType;
    actorId?: string;
    limit?: number;
  },
  transport: NotionTransport,
): Promise<AgencyNotionSyncReport> {
  const binding = requireBinding(store, input.agencyId, input.entityType);
  const report = emptyReport(input.entityType, binding.externalDatabaseId);
  if (binding.syncDirection === "push") {
    report.skipped += 1;
    report.errors.push("binding is push-only");
    return report;
  }
  const meta = await fetchNotionDatabaseMeta(transport, binding.externalDatabaseId);
  const fieldMap = buildFieldMap(input.entityType, meta);
  const pages = await queryNotionPages(transport, binding.externalDatabaseId, input.limit ?? 500);
  const now = Date.now();

  for (const page of pages) {
    report.scanned += 1;
    const externalId = String(page?.id ?? "");
    if (!externalId) {
      report.skipped += 1;
      continue;
    }
    try {
      const remote = readRemoteEntity(input.entityType, page, fieldMap);
      const link = store.findExternalLinkByExternalId(
        input.agencyId,
        NOTION_PROVIDER,
        externalId,
        input.entityType,
      );
      if (link) {
        const entity = store.getSyncableEntity(input.agencyId, input.entityType, link.entityId);
        if (!entity) {
          // The local row was deleted; the link is stale. Drop it so the next
          // pass treats the page as new rather than resurrecting a ghost.
          store.deleteExternalLink(
            input.agencyId,
            NOTION_PROVIDER,
            input.entityType,
            link.entityId,
          );
          report.skipped += 1;
          continue;
        }
        const localHash = hashAgencyEntity(input.entityType, entity);
        const verdict = classifyDrift(link, { localHash, remoteHash: remote.hash });
        if (verdict.state === "in_sync") {
          report.unchanged += 1;
          continue;
        }
        if (verdict.state === "conflict") {
          store.recordExternalLink(
            {
              agencyId: input.agencyId,
              provider: NOTION_PROVIDER,
              entityType: input.entityType,
              entityId: link.entityId,
              externalId,
              externalDatabaseId: binding.externalDatabaseId,
              externalUrl: typeof page?.url === "string" ? page.url : null,
              localHash: link.localHash,
              remoteHash: link.remoteHash,
              syncDirection: link.syncDirection,
              syncState: "conflict",
              lastSyncedAt: link.lastSyncedAt ?? now,
            },
            input.actorId,
          );
          report.conflicts += 1;
          continue;
        }
        if (verdict.state === "local_ahead") {
          // Nothing arrived from Notion; leave it for the push pass.
          report.skipped += 1;
          continue;
        }
        applyRemoteToLocal(
          store,
          input.agencyId,
          input.entityType,
          link.entityId,
          remote.fields,
          input.actorId,
        );
        const refreshed = store.getSyncableEntity(input.agencyId, input.entityType, link.entityId)!;
        store.recordExternalLink(
          {
            agencyId: input.agencyId,
            provider: NOTION_PROVIDER,
            entityType: input.entityType,
            entityId: link.entityId,
            externalId,
            externalDatabaseId: binding.externalDatabaseId,
            externalUrl: typeof page?.url === "string" ? page.url : null,
            localHash: hashAgencyEntity(input.entityType, refreshed),
            remoteHash: remote.hash,
            syncDirection: link.syncDirection,
            syncState: "in_sync",
            lastSyncedAt: now,
          },
          input.actorId,
        );
        report.updated += 1;
        continue;
      }

      const created = createLocalFromRemote(
        store,
        input.agencyId,
        input.entityType,
        remote.fields,
        input.actorId,
      );
      if (!created) {
        report.skipped += 1;
        continue;
      }
      store.recordExternalLink(
        {
          agencyId: input.agencyId,
          provider: NOTION_PROVIDER,
          entityType: input.entityType,
          entityId: String(created.id),
          externalId,
          externalDatabaseId: binding.externalDatabaseId,
          externalUrl: typeof page?.url === "string" ? page.url : null,
          localHash: hashAgencyEntity(input.entityType, created),
          remoteHash: remote.hash,
          syncDirection: binding.syncDirection,
          syncState: "in_sync",
          lastSyncedAt: now,
        },
        input.actorId,
      );
      report.created += 1;
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (shouldStampBinding(report, binding.lastPullAt)) {
    store.recordExternalBindingSync(input.agencyId, NOTION_PROVIDER, input.entityType, {
      lastPullAt: now,
      lastError: report.errors[0] ?? null,
    });
  }
  return report;
}

/**
 * Push: agency.db → Notion. Only rows whose local hash moved (or that have no
 * page yet) generate an API call, so a push over unchanged data issues zero
 * writes on both sides.
 */
export async function pushAgencyEntitiesToNotion(
  store: AgencyOperationsStore,
  input: {
    agencyId: string;
    entityType: ExternalEntityType;
    actorId?: string;
    limit?: number;
  },
  transport: NotionTransport,
): Promise<AgencyNotionSyncReport> {
  const binding = requireBinding(store, input.agencyId, input.entityType);
  const report = emptyReport(input.entityType, binding.externalDatabaseId);
  if (binding.syncDirection === "pull") {
    report.skipped += 1;
    report.errors.push("binding is pull-only");
    return report;
  }
  const meta = await fetchNotionDatabaseMeta(transport, binding.externalDatabaseId);
  const fieldMap = buildFieldMap(input.entityType, meta);
  const entities = store
    .listSyncableEntities(input.agencyId, input.entityType)
    .slice(0, Math.max(1, Math.min(2_000, input.limit ?? 500)));
  const now = Date.now();

  for (const entity of entities) {
    report.scanned += 1;
    const entityId = String(entity.id ?? "");
    if (!entityId) {
      report.skipped += 1;
      continue;
    }
    try {
      const localHash = hashAgencyEntity(input.entityType, entity);
      const link = store.getExternalLink(
        input.agencyId,
        NOTION_PROVIDER,
        input.entityType,
        entityId,
      );
      const properties = buildNotionProperties(input.entityType, entity, meta, fieldMap);
      if (!link) {
        const page = await transport.request("/pages", {
          method: "POST",
          body: { parent: { database_id: binding.externalDatabaseId }, properties },
        });
        const remote = readRemoteEntity(input.entityType, page, fieldMap);
        store.recordExternalLink(
          {
            agencyId: input.agencyId,
            provider: NOTION_PROVIDER,
            entityType: input.entityType,
            entityId,
            externalId: String(page?.id ?? ""),
            externalDatabaseId: binding.externalDatabaseId,
            externalUrl: typeof page?.url === "string" ? page.url : null,
            localHash,
            remoteHash: remote.hash,
            syncDirection: binding.syncDirection,
            syncState: "in_sync",
            lastSyncedAt: now,
          },
          input.actorId,
        );
        report.created += 1;
        continue;
      }
      if (link.localHash === localHash && link.syncState !== "conflict") {
        report.unchanged += 1;
        continue;
      }
      if (link.syncState === "conflict") {
        report.conflicts += 1;
        continue;
      }
      const page = await transport.request(`/pages/${link.externalId}`, {
        method: "PATCH",
        body: { properties },
      });
      const remote = readRemoteEntity(input.entityType, page, fieldMap);
      store.recordExternalLink(
        {
          agencyId: input.agencyId,
          provider: NOTION_PROVIDER,
          entityType: input.entityType,
          entityId,
          externalId: link.externalId,
          externalDatabaseId: binding.externalDatabaseId,
          externalUrl: typeof page?.url === "string" ? page.url : link.externalUrl,
          localHash,
          remoteHash: remote.hash,
          syncDirection: link.syncDirection,
          syncState: "in_sync",
          lastSyncedAt: now,
        },
        input.actorId,
      );
      report.updated += 1;
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (shouldStampBinding(report, binding.lastPushAt)) {
    store.recordExternalBindingSync(input.agencyId, NOTION_PROVIDER, input.entityType, {
      lastPushAt: now,
      lastError: report.errors[0] ?? null,
    });
  }
  return report;
}

/** Pull then push for one entity type, honouring the binding's direction. */
export async function syncAgencyEntitiesWithNotion(
  store: AgencyOperationsStore,
  input: { agencyId: string; entityType: ExternalEntityType; actorId?: string; limit?: number },
  transport: NotionTransport,
): Promise<{ pull: AgencyNotionSyncReport | null; push: AgencyNotionSyncReport | null }> {
  const binding = requireBinding(store, input.agencyId, input.entityType);
  const pull =
    binding.syncDirection === "push"
      ? null
      : await pullAgencyEntitiesFromNotion(store, input, transport);
  const push =
    binding.syncDirection === "pull"
      ? null
      : await pushAgencyEntitiesToNotion(store, input, transport);
  return { pull, push };
}

function applyRemoteToLocal(
  store: AgencyOperationsStore,
  agencyId: string,
  entityType: ExternalEntityType,
  entityId: string,
  fields: Record<string, unknown>,
  actorId?: string,
): void {
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const status = mapRemoteStatus(entityType, fields.status);
  switch (entityType) {
    case "client": {
      store.updateClient(
        entityId,
        {
          name: str(fields.name) ?? undefined,
          // Both are carried: the remote value verbatim as the real pipeline
          // status, and the mapped rollup where this build recognises it.
          pipelineStatus: str(fields.status) ?? undefined,
          status: (status as "prospect" | "active" | "inactive" | null) ?? undefined,
          billingEmail: str(fields.billingEmail),
          notes: str(fields.notes),
        },
        { agencyId, actorId },
      );
      return;
    }
    case "project": {
      const budget = num(fields.budget);
      store.updateProject(
        agencyId,
        entityId,
        {
          name: str(fields.name) ?? undefined,
          targetEndAt: num(fields.targetEndAt),
          budgetCents: budget === null ? undefined : Math.round(budget * 100),
        },
        actorId,
      );
      // Status is a validated state machine, not a free-text column. An
      // illegal remote value (e.g. "completed" straight from "planned") is
      // ignored rather than allowed to corrupt the lifecycle.
      if (status) {
        try {
          store.transitionProject(agencyId, entityId, status as AgencyProjectStatus, actorId);
        } catch {
          /* remote status is not a legal transition from here */
        }
      }
      return;
    }
    case "task": {
      store.updateTask(
        agencyId,
        entityId,
        {
          title: str(fields.title) ?? undefined,
          description: str(fields.description) ?? undefined,
          dueAt: num(fields.dueAt),
        },
        actorId,
      );
      if (status) {
        try {
          store.transitionTask(agencyId, entityId, status as AgencyTaskStatus, actorId);
        } catch {
          /* remote status is not a legal transition from here */
        }
      }
      return;
    }
    case "invoice":
      // Invoice state is money. It moves through issueInvoice/recordPayment
      // with their own validation, never because a mirrored spreadsheet cell
      // changed. Pull is a no-op for invoices by design.
      return;
  }
}

function createLocalFromRemote(
  store: AgencyOperationsStore,
  agencyId: string,
  entityType: ExternalEntityType,
  fields: Record<string, unknown>,
  actorId?: string,
): Record<string, unknown> | null {
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  switch (entityType) {
    case "client": {
      const name = str(fields.name);
      if (!name) return null;
      const client = store.createClient(
        {
          name,
          billingEmail: str(fields.billingEmail) ?? undefined,
          notes: str(fields.notes) ?? undefined,
          pipelineStatus: str(fields.status) ?? undefined,
        },
        { agencyId, actorId },
      );
      const status = mapRemoteStatus("client", fields.status);
      if (status && status !== client.status) {
        return store.updateClient(
          client.id,
          { status: status as "prospect" | "active" | "inactive" },
          { agencyId, actorId },
        ) as unknown as Record<string, unknown>;
      }
      return client as unknown as Record<string, unknown>;
    }
    case "project": {
      const name = str(fields.name);
      if (!name) return null;
      const budget = typeof fields.budget === "number" ? Math.round(fields.budget * 100) : 0;
      return store.createProject(
        agencyId,
        {
          name,
          budgetCents: budget,
          targetEndAt: typeof fields.targetEndAt === "number" ? fields.targetEndAt : undefined,
        },
        actorId,
      ) as unknown as Record<string, unknown>;
    }
    case "task":
      // Tasks are meaningless without a project, and inventing one from a
      // Notion row would create exactly the orphan rows this work exists to
      // eliminate. Unmatched remote tasks are reported as skipped.
      return null;
    case "invoice":
      // Invoices enter through the parser (`agency.ops.invoices.ingest`),
      // which validates totals and creates the revenue entries.
      return null;
  }
}

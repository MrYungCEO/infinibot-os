import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getDatabasesStore } from "../databases/store.js";
import { getKanbanStore } from "../tasks/store.js";
import type { KanbanProject, KanbanTask } from "../tasks/types.js";
import { deriveLegacyClientStatus, normalizeClientPipelineStatus } from "./client-status.js";
import { seedAgencyAiWorkforce } from "./seed-workforce.js";
import { AgencyOperationsStore } from "./store.js";
import type {
  AgencyProfile,
  AgencyProjectStatus,
  AgencyTaskStatus,
  LegacyMigrationStatus,
} from "./types.js";
import { getWorkforceStore } from "../workforce/index.js";

export const LEGACY_UNASSIGNED_AGENCY_ID = "legacy-unassigned";

export type LegacyClient = {
  id?: string;
  data?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

type LegacyBusiness = Record<string, unknown> & {
  id?: string;
  name?: string;
  clients?: LegacyClient[];
};

type LegacyBusinessState = {
  businesses?: LegacyBusiness[];
  activeBusinessId?: string | null;
};

export type LegacyMigrationOptions = {
  stateDir: string;
  actorId: string;
  operationsStore?: AgencyOperationsStore;
  quarantineUnassigned?: boolean;
  /**
   * Re-import even when business.json is byte-identical to the last completed
   * run. Only the explicit `agency.ops.migration.run` request sets this; the
   * implicit migration on agency list must stay cheap.
   */
  force?: boolean;
};

/**
 * Transitional compatibility writer. New agencies are mirrored into the old
 * profile file so legacy screens continue working while their reads/writes
 * are moved to agency APIs. The original file is backed up once and writes
 * are atomic.
 */
export function ensureLegacyBusinessMirror(input: {
  stateDir: string;
  agencyId: string;
  name: string;
}): void {
  mkdirSync(input.stateDir, { recursive: true });
  const source = readLegacyState(input.stateDir);
  const state = source.state as LegacyBusinessState & Record<string, unknown>;
  const businesses = Array.isArray(state.businesses) ? [...state.businesses] : [];
  const existing = businesses.find((business) => stringValue(business.id) === input.agencyId);
  if (existing) {
    if (stringValue(existing.name) !== input.name) existing.name = input.name;
  } else {
    const now = new Date().toISOString();
    businesses.push({
      id: input.agencyId,
      name: input.name,
      industry: "",
      plan: "",
      planNotionUrl: null,
      planContent: null,
      planContentFetchedAt: null,
      context: "",
      notionDatabaseId: null,
      notionDatabaseName: null,
      logo: null,
      website: null,
      email: null,
      phone: null,
      address: null,
      tagline: null,
      socialMedia: null,
      branding: null,
      productOfferingsNotionDbId: null,
      productOfferingsNotionDbName: null,
      productOfferingsSchema: null,
      products: [],
      productsLastSync: null,
      crmDatabaseId: null,
      crmDatabaseName: null,
      crmSchema: null,
      crmLastSync: null,
      clients: [],
      priorities: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  state.businesses = businesses;
  state.activeBusinessId = input.agencyId;
  const path = join(input.stateDir, "business.json");
  const backupPath = join(input.stateDir, "business.pre-agency-migration.json");
  if (existsSync(path) && !existsSync(backupPath)) copyFileSync(path, backupPath);
  const temporaryPath = join(input.stateDir, `.business.agency-migration-${process.pid}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized || null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timeValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function slugPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agency"
  );
}

function agencySlug(business: LegacyBusiness): string {
  const id = stringValue(business.id);
  return `legacy-${slugPart(stringValue(business.name) || id)}-${hash(id).slice(0, 8)}`;
}

function readLegacyState(stateDir: string): {
  path: string;
  exists: boolean;
  state: LegacyBusinessState;
  sourceHash: string;
  warnings: string[];
} {
  const path = join(stateDir, "business.json");
  if (!existsSync(path)) {
    return { path, exists: false, state: {}, sourceHash: hash(null), warnings: [] };
  }
  try {
    const text = readFileSync(path, "utf8");
    const state = JSON.parse(text) as LegacyBusinessState;
    return { path, exists: true, state, sourceHash: hash(state), warnings: [] };
  } catch (error) {
    return {
      path,
      exists: true,
      state: {},
      sourceHash: hash(null),
      warnings: [`Could not parse business.json: ${String(error)}`],
    };
  }
}

function profileFromLegacy(business: LegacyBusiness, now: number): AgencyProfile {
  return {
    agencyId: stringValue(business.id),
    industry: stringValue(business.industry),
    plan: stringValue(business.plan),
    context: stringValue(business.context),
    logo: nullableString(business.logo),
    website: nullableString(business.website),
    email: nullableString(business.email),
    phone: nullableString(business.phone),
    address: nullableString(business.address),
    tagline: nullableString(business.tagline),
    branding: objectValue(business.branding),
    socialMedia: objectValue(business.socialMedia),
    legacyBusinessId: stringValue(business.id),
    legacySnapshot: business,
    importedAt: now,
    updatedAt: timeValue(business.updatedAt, now),
  };
}

function legacyClientName(client: LegacyClient): string {
  const data = objectValue(client.data) ?? {};
  const candidates = [
    data.Name,
    data.name,
    data.Client,
    data.client,
    data.Company,
    data.company,
    data["Company Name"],
  ];
  return candidates.map(stringValue).find(Boolean) || `Legacy client ${stringValue(client.id)}`;
}

function legacyClientEmail(client: LegacyClient): string | null {
  const data = objectValue(client.data) ?? {};
  return nullableString(data.Email ?? data.email ?? data["Billing Email"]);
}

/**
 * The client's real pipeline status as recorded in the legacy/Notion data.
 * Blank counts as "Cold" — the owner's decision, and the reason 209 clients
 * with no status at all are cold leads rather than an unnamed fourth bucket.
 */
function legacyClientPipelineStatus(client: LegacyClient): string {
  const data = objectValue(client.data) ?? {};
  return normalizeClientPipelineStatus(data.Status ?? data.status ?? data.Stage ?? data.stage)
    .label;
}

/**
 * The three-value rollup. Derived, never authored: the mapping itself lives in
 * `deriveLegacyClientStatus` so store writes and this importer cannot drift.
 */
export function legacyClientStatus(client: LegacyClient): "prospect" | "active" | "inactive" {
  return deriveLegacyClientStatus(legacyClientPipelineStatus(client));
}

function projectStatus(project: KanbanProject): AgencyProjectStatus {
  switch (project.status) {
    case "In progress":
    case "Updating":
    case "Awaiting Client":
    case "Reviewing":
      return "active";
    case "Completed":
      return "completed";
    case "Paused":
      return "on_hold";
    case "Cancelled":
      return "cancelled";
    default:
      return "planned";
  }
}

function taskStatus(task: KanbanTask): AgencyTaskStatus {
  switch (task.status) {
    case "todo":
      return "ready";
    case "in_progress":
      return "in_progress";
    case "review":
      return "review";
    case "done":
      return "done";
    default:
      return "backlog";
  }
}

function taskPriority(task: KanbanTask): "low" | "normal" | "high" | "urgent" {
  const priority = stringValue(task.priorityLevel ?? task.priority).toLowerCase();
  if (priority === "immediate" || priority === "urgent") return "urgent";
  if (priority === "high") return "high";
  if (priority === "low") return "low";
  return "normal";
}

function dueAt(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyReport(sourceExists: boolean, businessesFound: number): LegacyMigrationStatus {
  return {
    source: "business.json",
    sourceExists,
    businessesFound,
    agenciesCreated: 0,
    agenciesUpdated: 0,
    clientsImported: 0,
    projectsImported: 0,
    tasksImported: 0,
    projectsQuarantined: 0,
    databaseRowsQuarantined: 0,
    unassignedAgencyId: null,
    completedAt: null,
    warnings: [],
  };
}

export async function previewLegacyBusinessMigration(
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationStatus> {
  const source = readLegacyState(options.stateDir);
  const businesses = Array.isArray(source.state.businesses) ? source.state.businesses : [];
  const report = emptyReport(source.exists, businesses.length);
  report.warnings.push(...source.warnings);
  const validIds = new Set(businesses.map((business) => stringValue(business.id)).filter(Boolean));
  const kanban = getKanbanStore(options.stateDir);
  const projects = await kanban.getProjects();
  const meta = kanban.getAllProjectMeta();
  report.clientsImported = businesses.reduce(
    (sum, business) => sum + (Array.isArray(business.clients) ? business.clients.length : 0),
    0,
  );
  report.projectsImported = projects.filter((project) =>
    validIds.has(meta[project.id]?.businessId ?? ""),
  ).length;
  report.tasksImported = (await kanban.getTasks()).filter((task) => {
    const project = projects.find((item) => item.id === task.projectId);
    return project ? validIds.has(meta[project.id]?.businessId ?? "") : false;
  }).length;
  report.projectsQuarantined = projects.filter((project) => !meta[project.id]?.businessId).length;
  const databases = getDatabasesStore(options.stateDir);
  report.databaseRowsQuarantined = databases
    .listDatabases()
    .reduce(
      (sum, database) => sum + databases.listRows(database.id, { businessId: null }).length,
      0,
    );
  if (report.projectsQuarantined || report.databaseRowsQuarantined) {
    report.unassignedAgencyId = LEGACY_UNASSIGNED_AGENCY_ID;
  }
  return report;
}

export async function migrateLegacyBusinessesToAgencies(
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationStatus> {
  const source = readLegacyState(options.stateDir);
  const businesses = Array.isArray(source.state.businesses) ? source.state.businesses : [];
  const store =
    options.operationsStore ??
    new AgencyOperationsStore(join(options.stateDir, "agency-operations", "agency.db"));
  const ownsStore = !options.operationsStore;
  const startedAt = Date.now();
  const runId = randomUUID();

  // agency.ops.agencies.list migrates on every call so a legacy install heals
  // itself without the user asking. That is only affordable when an unchanged
  // business.json is a no-op: a full re-import walks every client, project and
  // task, and better-sqlite3 blocks the gateway event loop while it does.
  // Replay the previous report instead when the source has not changed.
  if (!options.force) {
    const last = store.getLastCompletedLegacyMigration(options.actorId);
    if (last && last.sourceHash === source.sourceHash) {
      if (ownsStore) store.close();
      return last.report as LegacyMigrationStatus;
    }
  }

  const report = emptyReport(source.exists, businesses.length);
  const migratableAgencyIds = new Set<string>();
  report.warnings.push(...source.warnings);
  store.recordLegacyMigrationRun({
    id: runId,
    actorId: options.actorId,
    sourcePath: source.path,
    sourceHash: source.sourceHash,
    status: "running",
    report,
    startedAt,
  });

  try {
    for (const business of businesses) {
      const businessId = stringValue(business.id);
      if (!businessId) {
        report.warnings.push("Skipped a legacy business without an id.");
        continue;
      }
      const existing = store.getAgency(businessId);
      if (existing && existing.ownerUserId !== options.actorId) {
        report.warnings.push(`Skipped ${businessId}: its agency id is owned by another identity.`);
        continue;
      }
      if (!existing) {
        store.createAgency({
          id: businessId,
          name: stringValue(business.name) || "Legacy Agency",
          slug: agencySlug(business),
          ownerUserId: options.actorId,
          createdAt: timeValue(business.createdAt, startedAt),
        });
        report.agenciesCreated += 1;
      } else {
        if (stringValue(business.name) && existing.name !== stringValue(business.name)) {
          store.updateAgency(businessId, { name: stringValue(business.name) }, options.actorId);
        }
        store.ensureAgencyMembership(businessId, options.actorId, "owner");
        report.agenciesUpdated += 1;
      }
      store.upsertAgencyProfile(profileFromLegacy(business, startedAt), options.actorId);
      migratableAgencyIds.add(businessId);

      const workforce = getWorkforceStore(join(options.stateDir, "agency-operations", "agency.db"));
      if (workforce.listWorkers(businessId).length === 0) {
        seedAgencyAiWorkforce(workforce, businessId, options.actorId);
      }

      for (const client of Array.isArray(business.clients) ? business.clients : []) {
        const sourceId = stringValue(client.id);
        if (!sourceId) {
          report.warnings.push(`Skipped a client without an id in ${businessId}.`);
          continue;
        }
        store.importLegacyClient(
          {
            agencyId: businessId,
            sourceId,
            sourceHash: hash(client),
            name: legacyClientName(client),
            pipelineStatus: legacyClientPipelineStatus(client),
            billingEmail: legacyClientEmail(client),
            notes: JSON.stringify(client.data ?? {}),
            createdAt: timeValue(client.created_at, startedAt),
            updatedAt: timeValue(client.updated_at, startedAt),
          },
          options.actorId,
        );
        report.clientsImported += 1;
      }
    }

    const validAgencyIds = new Set(migratableAgencyIds);
    const kanban = getKanbanStore(options.stateDir);
    const projects = await kanban.getProjects();
    const projectMeta = kanban.getAllProjectMeta();
    const unassignedProjects = projects.filter((project) => !projectMeta[project.id]?.businessId);
    const databases = getDatabasesStore(options.stateDir);
    const unassignedRows = databases
      .listDatabases()
      .flatMap((database) =>
        databases.listRows(database.id, { businessId: null }).map((row) => ({ database, row })),
      );
    const quarantine =
      options.quarantineUnassigned !== false &&
      (unassignedProjects.length > 0 || unassignedRows.length > 0);
    if (quarantine) {
      const existingUnassigned = store.getAgency(LEGACY_UNASSIGNED_AGENCY_ID);
      if (existingUnassigned && existingUnassigned.ownerUserId !== options.actorId) {
        report.warnings.push(
          "Unassigned legacy data was not claimed because its quarantine agency has another owner.",
        );
      } else if (!existingUnassigned) {
        store.createAgency({
          id: LEGACY_UNASSIGNED_AGENCY_ID,
          name: "Legacy Unassigned",
          slug: `legacy-unassigned-${hash(options.actorId).slice(0, 8)}`,
          ownerUserId: options.actorId,
        });
        report.agenciesCreated += 1;
      } else {
        store.ensureAgencyMembership(LEGACY_UNASSIGNED_AGENCY_ID, options.actorId, "owner");
      }
      if (!existingUnassigned || existingUnassigned.ownerUserId === options.actorId) {
        validAgencyIds.add(LEGACY_UNASSIGNED_AGENCY_ID);
        report.unassignedAgencyId = LEGACY_UNASSIGNED_AGENCY_ID;
        for (const project of unassignedProjects) {
          kanban.setProjectMeta(project.id, { businessId: LEGACY_UNASSIGNED_AGENCY_ID });
          report.projectsQuarantined += 1;
        }
        const rowsByDatabase = new Map<string, string[]>();
        for (const { database, row } of unassignedRows) {
          const ids = rowsByDatabase.get(database.id) ?? [];
          ids.push(row.id);
          rowsByDatabase.set(database.id, ids);
        }
        for (const [databaseId, rowIds] of rowsByDatabase) {
          report.databaseRowsQuarantined += databases.scopeRowsToBusiness({
            databaseId,
            rowIds,
            businessId: LEGACY_UNASSIGNED_AGENCY_ID,
          });
        }
      }
    }

    const refreshedMeta = kanban.getAllProjectMeta();
    const projectTargetIds = new Map<string, { agencyId: string; targetId: string }>();
    for (const project of projects) {
      const agencyId = refreshedMeta[project.id]?.businessId ?? "";
      if (!validAgencyIds.has(agencyId)) {
        if (agencyId)
          report.warnings.push(`Project ${project.id} references unknown business ${agencyId}.`);
        continue;
      }
      const mapping = store.getLegacyEntityMapping(agencyId, "project", project.id);
      const targetId = mapping?.targetId ?? `legacy-project:${agencyId}:${project.id}`;
      store.importLegacyProject(
        {
          id: targetId,
          sourceId: project.id,
          sourceHash: hash(project),
          agencyId,
          clientId: null,
          name: project.name || "Untitled legacy project",
          status: projectStatus(project),
          ownerId: null,
          startAt: null,
          targetEndAt: dueAt(project.dueDate),
          budgetCents: Math.max(0, Math.round((project.paidAmount ?? 0) * 100)),
          mrrCents: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
        options.actorId,
      );
      projectTargetIds.set(project.id, { agencyId, targetId });
      report.projectsImported += 1;
    }

    for (const task of await kanban.getTasks()) {
      const targetProject = projectTargetIds.get(task.projectId);
      if (!targetProject) continue;
      const mapping = store.getLegacyEntityMapping(targetProject.agencyId, "task", task.id);
      store.importLegacyTask(
        {
          id: mapping?.targetId ?? `legacy-task:${targetProject.agencyId}:${task.id}`,
          sourceId: task.id,
          sourceHash: hash(task),
          agencyId: targetProject.agencyId,
          projectId: targetProject.targetId,
          parentTaskId: null,
          title: task.title || "Untitled legacy task",
          description: task.description ?? task.content ?? "",
          status: taskStatus(task),
          priority: taskPriority(task),
          assigneeType: task.assignedAgent ? "ai" : null,
          assigneeId: task.assignedAgent ?? null,
          acceptanceCriteria: "Preserve legacy task requirements and completion state.",
          dueAt: dueAt(task.dueDate),
          completedAt: task.completedAt ?? (task.status === "done" ? task.updatedAt : null),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
        options.actorId,
      );
      report.tasksImported += 1;
    }

    report.completedAt = Date.now();
    store.recordLegacyMigrationRun({
      id: runId,
      actorId: options.actorId,
      sourcePath: source.path,
      sourceHash: source.sourceHash,
      status: "completed",
      report,
      startedAt,
      completedAt: report.completedAt,
    });
    return report;
  } catch (error) {
    report.warnings.push(`Migration stopped safely: ${String(error)}`);
    store.recordLegacyMigrationRun({
      id: runId,
      actorId: options.actorId,
      sourcePath: source.path,
      sourceHash: source.sourceHash,
      status: "failed",
      report,
      startedAt,
      completedAt: Date.now(),
    });
    throw error;
  } finally {
    if (ownsStore) store.close();
  }
}

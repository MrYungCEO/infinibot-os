import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { createTailscaleCollaborationService } from "../../agency-collaboration/index.js";
import { listProjects as listKanbanProjects } from "../../databases/kanban-store-ops.js";
import {
  KNOWN_CLIENT_PIPELINE_STATUSES,
  MAX_CLIENT_PIPELINE_STATUS_LENGTH,
  isKnownClientPipelineStatus,
  getAgencyOperationsStore,
  createAgencyDatabaseResilience,
  resetAgencyFunnelStores,
  resetAgencyOperationsStores,
  getAgencyFunnelStore,
  AgencyFunnelHealthService,
  ensureLegacyBusinessMirror,
  migrateLegacyBusinessesToAgencies,
  previewLegacyBusinessMigration,
  type AgencyRole,
  type AgencyTaskStatus,
  type EngagementStatus,
  type OpportunityStage,
  type AgencyProjectStatus,
  type AgencyFunnelKind,
  type AgencyFunnelNodeType,
  parseInvoice,
  extractInvoiceText,
  type InvoiceLineItemInput,
  type InvoiceStatus,
  type ProposalSectionRecord,
  type ProposalStatus,
  NOTION_PROVIDER,
  buildFieldMap,
  connectAgencyNotionDatabase,
  createNotionTransport,
  isExternalEntityType,
  isExternalSyncDirection,
  listNotionDatabases,
  pullAgencyEntitiesFromNotion,
  pushAgencyEntitiesToNotion,
  syncAgencyEntitiesWithNotion,
  type ExternalEntityType,
  type ExternalSyncDirection,
  type ExternalSyncState,
  type InvoicePaymentLink,
  type NotionTransport,
  WHOP_PROVIDER,
  createWhopTransport,
  createWhopCheckoutLink,
  deleteWhopCheckoutLink,
  listWhopPayments,
  reconcilePayments,
  PAYMENT_MATCH_REASONS,
  type ExternalPaymentReceiptStatus,
} from "../../agency-operations/index.js";
import { resolveWhopCredentials } from "./business-income.js";
import { getHubDb } from "../../business-hub/db.js";
import {
  revenueArAging as hubRevenueArAging,
  syncAgencyRevenueToLedger,
} from "../../business-hub/revenue/canonical.js";
import { revenueSummary as hubRevenueSummary } from "../../business-hub/revenue/metrics.js";
import {
  buildInvoiceDocumentModel,
  buildProposalDocumentModel,
  checkTotalsConsistency,
  effectiveInvoiceStatus,
  effectiveProposalStatus,
  enqueueReport,
  invoiceSummaryText,
  proposalSummaryText,
  renderInvoiceDocumentHtml,
  renderProposalDocumentHtml,
  setReportAssociations,
  DEFAULT_DOCUMENT_THEME,
  INVOICE_REPORT_KIND,
  PROPOSAL_REPORT_KIND,
  type InvoiceDocumentModel,
  type ProposalDocumentModel,
} from "../../reports/index.js";
import { getNotionApiKeyForImport, getNotionConfig } from "../../databases/notion-config.js";
import { seedAgencyAiWorkforce } from "../../agency-operations/seed-workforce.js";
import { resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import { getUserStore } from "../../users/store.js";
import {
  getWorkforceStore,
  WorkforceOperatingStore,
  resetWorkforceStore,
  planHybridTeam,
  scoreWorkerSuitability,
  type AssignmentMember,
  type AssignmentStatus,
  type EmploymentStatus,
  type HybridTeamRequest,
  type SkillRequirement,
  type SuitabilityRequest,
  type WorkItemPriority,
  type WorkItemStatus,
  createWorkItemExecutorConfig,
  describeWorkItemExecution,
  listExecutionEligibleWorkItems,
  EXECUTION_STAGE,
  type WorkItemExecutionViewDeps,
  WorkforceSopStore,
  attachSopSchedule,
  detachSopSchedule,
  runSopOnce,
  seedAgencySops,
  suggestedScheduleFor,
  SOP_SEED_VERSION,
  type SopCadence,
  type SopScheduleInput,
  type SopServiceDeps,
  type SopStatus,
  planResponse,
  resolveCommunicationProfile,
  effectiveChannelProfile,
  summarizeCommunicationProfile,
  resolveExecutionProfile,
  COMMUNICATION_TONES,
  COMMUNICATION_VERBOSITY,
  PROACTIVITY_LEVELS,
  EMOJI_USAGE,
  OUTSIDE_HOURS_BEHAVIOURS,
  REPORT_CADENCES,
  CHANNEL_BINDING_DIRECTIONS,
  parseChannelId,
  WorkforceRoutingStore,
  DEFAULT_TASK_ROUTING_POLICY,
  TASK_AUTOSTAGE_MODES,
  applyTaskRouting,
  previewTaskRouting,
  overrideTaskRouting,
  stageRoutedWork,
  unassignTask,
  type TaskAutostageMode,
  type TaskRouterDeps,
  type TaskRoutingLimits,
  type TaskRoutingOutcome,
  WorkforceEscalationStore,
  EscalationService,
  createEscalationReplyObserver,
  registerEscalationReplyObserver,
  parseEscalationKind,
  parseEscalationStatus,
  parseEscalationUrgency,
  ESCALATION_KINDS,
  ESCALATION_URGENCIES,
  ESCALATION_STATUSES,
  ESCALATION_RECIPIENTS,
  APPROVAL_STATES,
  DIGEST_CADENCES,
  type EscalationTransport,
} from "../../workforce/index.js";
import { sendMessage } from "../../infra/outbound/message.js";
import {
  agencyProvisioningStatus,
  ensureAgencyProvisioned,
} from "../../agency-operations/provisioning.js";
import { listChatChannels } from "../../channels/registry.js";
import { loadConfig } from "../../config/config.js";
import { getFunnelStore } from "../../funnels/store.js";
import { getFederationSatellite, type FederationSatellite } from "../../federation/satellite.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Actor = { id: string; email: string | null; displayName: string };

const collaboration = createTailscaleCollaborationService();
let databaseResilience: ReturnType<typeof createAgencyDatabaseResilience> | null = null;
const funnelHealth = new AgencyFunnelHealthService();
const replicationHooks = new WeakSet<FederationSatellite>();
const replicationInFlight = new Map<string, Promise<unknown>>();
let replicationTimer: NodeJS.Timeout | null = null;

const EMPLOYMENT_STATUSES: EmploymentStatus[] = ["active", "on_leave", "inactive", "terminated"];
/** Statuses `agency.ops.employee.deactivate` may transition a worker into. */
const DEACTIVATION_STATUSES: EmploymentStatus[] = ["on_leave", "inactive", "terminated"];

function operationsStore() {
  return getAgencyOperationsStore(resolveStateDir());
}

/** Keep Agency Invoicing and Business Hub Revenue on one canonical read ledger. */
function syncCanonicalAgencyRevenue(agencyId: string) {
  const db = getHubDb();
  return {
    db,
    merge: syncAgencyRevenueToLedger(db, { stateDir: resolveStateDir(), agencyId }),
  };
}

/**
 * Per-project MRR entered on the /projects header popover lives in the kanban
 * store (a different SQLite DB than agency-operations). The Agency Operations
 * MRR statistic is the sum of that manually-set project MRR, so we read the
 * kanban projects here and total their `mrr` field (USD → cents). Bridging at
 * the gateway layer keeps the agency-operations store free of a cross-store
 * dependency. Returns 0 and never throws if the kanban store is unavailable.
 */
function kanbanProjectsMrrCents(): number {
  try {
    const projects = listKanbanProjects();
    return projects.reduce((sum, p) => {
      const mrr = typeof p.mrr === "number" && Number.isFinite(p.mrr) && p.mrr > 0 ? p.mrr : 0;
      return sum + Math.round(mrr * 100);
    }, 0);
  } catch {
    return 0;
  }
}

function resilience() {
  if (!databaseResilience) {
    databaseResilience = createAgencyDatabaseResilience({
      databasePath: join(resolveStateDir(), "agency-operations", "agency.db"),
      closeDatabaseUsers: () => {
        resetAgencyFunnelStores();
        resetWorkforceStore();
        resetWorkforceSopStore();
        resetWorkforceRoutingStore();
        resetAgencyOperationsStores();
      },
    });
  }
  return databaseResilience;
}

function workforceStore() {
  return getWorkforceStore(join(resolveStateDir(), "agency-operations", "agency.db"));
}

let operatingStoreInstance: WorkforceOperatingStore | null = null;
function workforceOperatingStore() {
  operatingStoreInstance ??= new WorkforceOperatingStore(
    join(resolveStateDir(), "agency-operations", "agency.db"),
  );
  return operatingStoreInstance;
}

let sopStoreInstance: WorkforceSopStore | null = null;
/** Drop the cached handle so a restore/backup can replace the database file. */
function resetWorkforceSopStore() {
  try {
    sopStoreInstance?.close();
  } catch {
    /* an already-closed handle is fine */
  }
  sopStoreInstance = null;
}
function workforceSopStore() {
  sopStoreInstance ??= new WorkforceSopStore(
    join(resolveStateDir(), "agency-operations", "agency.db"),
  );
  return sopStoreInstance;
}

let routingStoreInstance: WorkforceRoutingStore | null = null;
/** Drop the cached handle so a restore/backup can replace the database file. */
function resetWorkforceRoutingStore() {
  try {
    routingStoreInstance?.close();
  } catch {
    /* an already-closed handle is fine */
  }
  routingStoreInstance = null;
}
function workforceRoutingStore() {
  routingStoreInstance ??= new WorkforceRoutingStore(
    join(resolveStateDir(), "agency-operations", "agency.db"),
  );
  return routingStoreInstance;
}

/**
 * Dependency bundle for the task router. `broadcast` is threaded through so
 * every auto-staged card emits `agency.routing.staged` — that event is how the
 * owner (and the escalation agent) find out what was started on their behalf
 * and why, without a human having authorised each card individually.
 */
function taskRouterDeps(opts?: GatewayRequestHandlerOptions): TaskRouterDeps {
  return {
    operationsStore: operationsStore(),
    workerStore: workforceStore(),
    operatingStore: workforceOperatingStore(),
    routingStore: workforceRoutingStore(),
    broadcast: opts
      ? (event, payload) => opts.context.broadcast(event, payload, { dropIfSlow: true })
      : undefined,
  };
}

/** Dependency bundle for first-run provisioning. */
function provisioningDeps(opts?: GatewayRequestHandlerOptions) {
  return {
    workerStore: workforceStore(),
    sopStore: workforceSopStore(),
    routingStore: workforceRoutingStore(),
    sopService: { operatingStore: workforceOperatingStore(), cron: opts?.context.cron ?? null },
  };
}

/** Optional routing limit overrides sent by the UI's dry-run controls. */
function routingLimitOverrides(params: Record<string, unknown>): Partial<TaskRoutingLimits> {
  const limits: Partial<TaskRoutingLimits> = {};
  if (typeof params.minScore === "number") limits.minScore = params.minScore;
  if (typeof params.minMatchStrength === "number") {
    limits.minMatchStrength = params.minMatchStrength;
  }
  if (typeof params.maxAssignments === "number") {
    limits.maxAssignmentsPerPass = params.maxAssignments;
  }
  if (typeof params.maxTasksPerWorker === "number") {
    limits.maxTasksPerWorkerPerPass = params.maxTasksPerWorker;
  }
  if (typeof params.capacityHeadroom === "number") {
    limits.capacityHeadroom = params.capacityHeadroom;
  }
  if (typeof params.defaultEstimatedHours === "number") {
    limits.defaultEstimatedHours = params.defaultEstimatedHours;
  }
  return limits;
}

function autostageModeParam(value: unknown): TaskAutostageMode | undefined {
  return typeof value === "string" && TASK_AUTOSTAGE_MODES.includes(value as TaskAutostageMode)
    ? (value as TaskAutostageMode)
    : undefined;
}

/**
 * Dependency bundle for the SOP service. The cron service is threaded through
 * so attaching a schedule creates a REAL, operator-visible cron job rather than
 * just a row.
 */
function sopServiceDeps(opts: GatewayRequestHandlerOptions): SopServiceDeps {
  return {
    sopStore: workforceSopStore(),
    operatingStore: workforceOperatingStore(),
    cron: opts.context.cron,
    workerStore: workforceStore(),
  };
}

/**
 * Map the six seed roles onto the worker ids that own them. Keyed on `agentId`
 * so pre-v2 workers adopted in place keep their original id.
 */
function workerIdsByRoleId(agencyId: string): Map<string, string> {
  const byRole = new Map<string, string>();
  for (const worker of workforceStore().listWorkers(agencyId, { type: "ai" })) {
    if (worker.agentId) byRole.set(worker.agentId, worker.id);
  }
  return byRole;
}

/** SOP plus the cadence the starter set suggests for it (UI one-click attach). */
function sopPayload(sop: ReturnType<WorkforceSopStore["getSop"]>) {
  if (!sop) return null;
  return { ...sop, suggestedSchedule: suggestedScheduleFor(sop.slug) };
}

/**
 * The legal enum values for the communication profile, shipped with the
 * profile so the UI renders its selects from the server's own vocabulary
 * rather than a hand-copied list that can drift.
 */
function communicationOptions() {
  return {
    tones: COMMUNICATION_TONES,
    verbosity: COMMUNICATION_VERBOSITY,
    proactivity: PROACTIVITY_LEVELS,
    emojiUse: EMOJI_USAGE,
    outsideHours: OUTSIDE_HOURS_BEHAVIOURS,
    reportCadences: REPORT_CADENCES,
    directions: CHANNEL_BINDING_DIRECTIONS,
    channels: listChatChannels().map((meta) => ({ id: meta.id, label: meta.label })),
  };
}

// ── Escalation protocol wiring ───────────────────────────────────────────────

let escalationStoreInstance: WorkforceEscalationStore | null = null;
function escalationStore() {
  escalationStoreInstance ??= new WorkforceEscalationStore(
    join(resolveStateDir(), "agency-operations", "agency.db"),
  );
  return escalationStoreInstance;
}

/**
 * Put an escalation on a real channel through the existing outbound plumbing
 * (`src/infra/outbound/message.ts`), which owns chunking, media limits and the
 * per-channel adapters. Nothing here knows what a channel credential is: the
 * escalation carries a routing target and a body, and that is all.
 */
const escalationTransport: EscalationTransport = async (request) => {
  if (!request.to) throw new Error("no delivery target bound for this channel");
  const sent = await sendMessage({
    to: request.to,
    content: request.text,
    channel: request.channelId,
  });
  return { messageId: sent.result?.messageId ?? null };
};

let escalationObserverRegistered = false;

/**
 * Register the inbound observer once, lazily. Correlation is by the
 * `[#ESC-XXXXXX]` tag in the message body, which is the only mechanism that
 * works identically on all seven chat channels.
 */
function ensureEscalationInboundWiring(opts: GatewayRequestHandlerOptions): void {
  if (escalationObserverRegistered) return;
  escalationObserverRegistered = true;
  registerEscalationReplyObserver(
    createEscalationReplyObserver({ service: escalationService(opts) }),
  );
}

function escalationService(opts: GatewayRequestHandlerOptions): EscalationService {
  const service = new EscalationService({
    store: escalationStore(),
    workerStore: workforceStore(),
    operatingStore: workforceOperatingStore(),
    transport: escalationTransport,
    broadcast: (event, payload) => opts.context.broadcast(event, payload, { dropIfSlow: true }),
  });
  ensureEscalationInboundWiring(opts);
  return service;
}

/** Server-owned vocabulary for the escalation UI. */
function escalationOptions() {
  return {
    kinds: ESCALATION_KINDS,
    urgencies: ESCALATION_URGENCIES,
    statuses: ESCALATION_STATUSES,
    recipients: ESCALATION_RECIPIENTS,
    approvalStates: APPROVAL_STATES,
    digestCadences: DIGEST_CADENCES,
    channels: listChatChannels().map((meta) => ({ id: meta.id, label: meta.label })),
  };
}

function agencyFunnelStore() {
  return getAgencyFunnelStore(resolveStateDir());
}

/**
 * Executor settings as the gateway sees them. `enabled` is false unless the
 * operator explicitly set `cron.agencyOperatingLoop.executeWorkItems`.
 */
function workItemExecutorConfig() {
  const cfg = loadConfig() as { cron?: { agencyOperatingLoop?: unknown } };
  return createWorkItemExecutorConfig(
    (cfg.cron?.agencyOperatingLoop ?? null) as Parameters<typeof createWorkItemExecutorConfig>[0],
  );
}

/** Read-only dependency bundle for the board's execution views. */
function workItemExecutionViewDeps(): WorkItemExecutionViewDeps {
  return {
    operatingStore: workforceOperatingStore(),
    workerStore: workforceStore(),
    config: workItemExecutorConfig(),
  };
}

function localReplicationNodeId(): string {
  return getFederationSatellite()?.getManifest().id ?? "master";
}

async function syncAgencyWithMaster(agencyId: string) {
  const existing = replicationInFlight.get(agencyId);
  if (existing) return existing;
  const operation = (async () => {
    const store = operationsStore();
    const satellite = getFederationSatellite();
    const nodeId = satellite?.getManifest().id ?? "master";
    if (!satellite) {
      return { status: store.getReplicationStatus(agencyId, nodeId), authoritative: true };
    }
    if (satellite.getState() !== "connected") {
      store.recordReplicationStatus(agencyId, {
        peerNodeId: "master",
        status: "offline",
        localDigest: store.exportReplicationSnapshot(agencyId, nodeId).digest,
        error: "Master unavailable; local changes are safely retained.",
      });
      return { status: store.getReplicationStatus(agencyId, nodeId), authoritative: false };
    }

    const snapshot = store.exportReplicationSnapshot(agencyId, nodeId);
    const pushedAt = Date.now();
    const pushed = await satellite.invokeOnMaster(
      "agency.ops.replication.merge",
      { agencyId, snapshot },
      120_000,
    );
    if (!pushed.success) {
      store.recordReplicationStatus(agencyId, {
        peerNodeId: "master",
        status: pushed.error?.code === "NOT_CONNECTED" ? "offline" : "error",
        localDigest: snapshot.digest,
        error: pushed.error?.message ?? "Master replication failed",
      });
      return { status: store.getReplicationStatus(agencyId, nodeId), authoritative: false };
    }
    store.recordReplicationStatus(agencyId, {
      peerNodeId: "master",
      status: "pending",
      lastPushAt: pushedAt,
      localDigest: snapshot.digest,
      error: null,
    });

    const pulled = await satellite.invokeOnMaster(
      "agency.ops.replication.export",
      { agencyId, sourceNodeId: "master" },
      120_000,
    );
    if (!pulled.success) {
      store.recordReplicationStatus(agencyId, {
        peerNodeId: "master",
        status: pulled.error?.code === "NOT_CONNECTED" ? "offline" : "error",
        lastPushAt: pushedAt,
        localDigest: snapshot.digest,
        error: pulled.error?.message ?? "Master replication pull failed",
      });
      return { status: store.getReplicationStatus(agencyId, nodeId), authoritative: false };
    }
    const remoteSnapshot = (
      pulled.data && typeof pulled.data === "object" && "snapshot" in pulled.data
        ? (pulled.data as { snapshot: unknown }).snapshot
        : pulled.data
    ) as Parameters<typeof store.mergeReplicationSnapshot>[0];
    const merge = store.mergeReplicationSnapshot(remoteSnapshot, nodeId);
    const finalSnapshot = store.exportReplicationSnapshot(agencyId, nodeId);
    store.recordReplicationStatus(agencyId, {
      peerNodeId: "master",
      status: finalSnapshot.digest === remoteSnapshot.digest ? "in_sync" : "pending",
      lastSyncAt: Date.now(),
      lastPushAt: pushedAt,
      lastPullAt: Date.now(),
      localDigest: finalSnapshot.digest,
      remoteDigest: remoteSnapshot.digest,
      conflicts: 0,
      error: null,
    });
    return {
      status: store.getReplicationStatus(agencyId, nodeId),
      authoritative: false,
      merge,
    };
  })().finally(() => replicationInFlight.delete(agencyId));
  replicationInFlight.set(agencyId, operation);
  return operation;
}

function ensureReplicationLoop(actor: Actor): void {
  const satellite = getFederationSatellite();
  if (!satellite) return;
  const syncAccessibleAgencies = () => {
    for (const agency of operationsStore().listAgenciesForUser(actor.id)) {
      void syncAgencyWithMaster(agency.id);
    }
  };
  if (!replicationHooks.has(satellite)) {
    replicationHooks.add(satellite);
    satellite.on("connected", syncAccessibleAgencies);
  }
  if (!replicationTimer) {
    replicationTimer = setInterval(syncAccessibleAgencies, 30_000);
    replicationTimer.unref();
  }
}

function legacyFunnelKind(type: string): AgencyFunnelKind {
  if (type === "onboarding") return "client_onboarding";
  if (type === "recruitment") return "recruitment";
  if (type === "sales" || type === "marketing")
    return type === "sales" ? "sales" : "lead_generation";
  return "custom";
}

function legacyNodeType(type: string): AgencyFunnelNodeType {
  if (type === "entry") return "source";
  if (type === "decision") return "decision";
  if (type === "exit") return "exit";
  return "action";
}

/**
 * One-time, ID-preserving bridge from the former funnel database. Once rows
 * exist in agency.db the Agency Funnel Store is authoritative.
 */
function ensureLegacyFunnelBridge(agencyId: string): void {
  const target = agencyFunnelStore();
  if (target.listFunnels(agencyId).length > 0) return;
  const source = getFunnelStore();
  const legacy = source
    .getFunnels({ businessId: agencyId })
    .filter((funnel) => funnel.status !== "archived")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!legacy.length) return;

  const coreLegacy = legacy[0]!;
  const core = target.createFunnel(agencyId, {
    id: `agency-funnel:${coreLegacy.id}`,
    legacyFunnelId: coreLegacy.id,
    name: coreLegacy.name,
    description: coreLegacy.description,
    kind: legacyFunnelKind(coreLegacy.type),
    objective: coreLegacy.description || `Operate ${coreLegacy.name} as the agency's core journey.`,
  });
  for (const sub of legacy.slice(1)) {
    target.createSubFunnel(agencyId, core.id, {
      id: `agency-funnel:${sub.id}`,
      legacyFunnelId: sub.id,
      name: sub.name,
      description: sub.description,
      kind: legacyFunnelKind(sub.type),
      objective: sub.description || `Operate ${sub.name} as a connected sub-funnel.`,
    });
  }

  const nodeIds = new Map<string, string>();
  for (const [index, stage] of source.getStages(coreLegacy.id).entries()) {
    const nodeId = `agency-node:${coreLegacy.id}:${stage.id}`;
    nodeIds.set(stage.id, nodeId);
    const node = target.createNode(agencyId, core.id, {
      id: nodeId,
      nodeType: legacyNodeType(stage.type),
      name: stage.name,
      description: stage.description,
      config: {
        legacyStageId: stage.id,
        libraryId: stage.libraryId,
        items: stage.items ?? [],
        pageLink: stage.pageLink ?? null,
        kpiTracking: stage.kpiTracking ?? null,
      },
      positionX: Number(stage.column ?? index) * 240,
      positionY: Number(stage.row ?? 0) * 160,
      sortOrder: stage.position ?? index,
    });
    if (stage.integration) {
      const connection = target.upsertConnection(agencyId, core.id, {
        nodeId: node.id,
        provider: stage.libraryId || stage.name,
        connectionKey: `legacy:${coreLegacy.id}:${stage.id}`,
        status: stage.integration.connected ? "connected" : "disconnected",
        config: { type: stage.integration.type, lastSync: stage.integration.lastSync ?? null },
      });
      target.createRequirement(agencyId, core.id, {
        nodeId: node.id,
        connectionId: connection.id,
        kind: "integration",
        name: `Connect ${stage.name}`,
        description: `Required integration for ${stage.name}.`,
        status: stage.integration.connected ? "satisfied" : "missing",
      });
    }
  }
  for (const connection of source.getConnections(coreLegacy.id)) {
    const sourceNodeId = nodeIds.get(connection.sourceStageId);
    const targetNodeId = nodeIds.get(connection.targetStageId);
    if (!sourceNodeId || !targetNodeId) continue;
    target.createEdge(agencyId, core.id, {
      sourceNodeId,
      targetNodeId,
      label: connection.label,
      condition: connection.conditionConfig,
    });
  }
}

function resolveAgencyFunnelId(agencyId: string, requested?: string): string | null {
  ensureLegacyFunnelBridge(agencyId);
  return agencyFunnelStore().resolveCoreFunnel(agencyId, requested)?.id ?? null;
}

function actorFor(opts: GatewayRequestHandlerOptions): Actor {
  const authUser = opts.client?.authUser?.trim().toLowerCase();
  if (opts.client?.authMethod === "tailscale" && authUser) {
    return {
      id: `tailscale:${authUser}`,
      email: authUser.includes("@") ? authUser : null,
      displayName: authUser,
    };
  }
  const password = opts.client?.connect.auth?.password;
  if (typeof password === "string" && password) {
    const user = getUserStore(resolveStateDir()).findByGatewayPassword(password);
    if (user) {
      return { id: user.id, email: user.email, displayName: user.username };
    }
  }
  return { id: "local-owner", email: null, displayName: "Local owner" };
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A pipeline status param is validated for *shape*, not membership: an
 * unrecognised value is real data from the owner's pipeline and must be
 * stored verbatim rather than rejected. Only nonsense (wrong type, absurd
 * length) is refused.
 */
function clientPipelineStatusParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("pipelineStatus must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("pipelineStatus must not be blank");
  if (trimmed.length > MAX_CLIENT_PIPELINE_STATUS_LENGTH) {
    throw new Error(
      `pipelineStatus must be at most ${MAX_CLIENT_PIPELINE_STATUS_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** `["a","b"]` from an unknown RPC param; anything else becomes `[]`. */
function stringListParam(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Ordered SOP steps from an RPC param. Only structural shaping happens here —
 * trimming, length limits and dense renumbering are the store's job.
 */
function sopStepsParam(value: unknown): Array<{
  title: string;
  instruction: string;
  expectedOutput?: string | null;
  required?: boolean;
  toolHint?: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      title: String(entry.title ?? ""),
      instruction: String(entry.instruction ?? ""),
      expectedOutput: typeof entry.expectedOutput === "string" ? entry.expectedOutput : null,
      required: entry.required !== false,
      toolHint: typeof entry.toolHint === "string" ? entry.toolHint : null,
    }));
}

/** Declared inputs/outputs from an RPC param. */
function sopIoParam(
  value: unknown,
): Array<{ name: string; description?: string; required?: boolean }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      name: String(entry.name ?? ""),
      description: typeof entry.description === "string" ? entry.description : "",
      required: entry.required !== false,
    }));
}

function numberParam(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cents(value: unknown): number {
  return Math.round(numberParam(value) * 100);
}

function externalEntityTypeParam(value: unknown): ExternalEntityType {
  if (!isExternalEntityType(value)) {
    throw new Error("entityType must be one of client, project, task, invoice");
  }
  return value;
}

function externalDirectionParam(value: unknown): ExternalSyncDirection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isExternalSyncDirection(value)) {
    throw new Error("syncDirection must be one of pull, push, bidirectional");
  }
  return value;
}

/**
 * Built per request rather than cached: the operator can change the Notion key
 * at runtime, and a cached transport would keep using the revoked one. Throws
 * a clean "Notion is not configured" that `run` surfaces as INVALID_REQUEST.
 */
function notionTransport(): NotionTransport {
  return createNotionTransport();
}

/**
 * Ensure the `external_provider_bindings` table has one row per entity type
 * for any database ID that the wizard stored in infinibot.json but that was
 * never explicitly connected via `agency.ops.notion.connect`.
 *
 * This is a best-effort seed: it inserts a minimal binding (no schema/field
 * map) so `notion.sync` can resolve an entityType list without requiring the
 * operator to manually re-run the wizard. The real schema is populated on the
 * first pull/push when the Notion API is actually called.
 *
 * Call this at the START of any handler that enumerates bindings, before
 * acting on the list — the seed is idempotent (upsert, not insert-or-fail).
 */
function seedNotionBindingsFromConfig(
  store: ReturnType<typeof operationsStore>,
  agencyId: string,
  actorId?: string,
): void {
  const cfg = getNotionConfig();
  const existing = new Set(
    store.listExternalBindings(agencyId, NOTION_PROVIDER).map((b) => b.entityType),
  );
  // Only the CRM-specific Notion DB IDs belong in agency.db bindings.
  // projectsDbId / tasksDbId point to the KANBAN Notion DBs (synced via
  // kanban.ts) — registering them here would cross-wire the wrong tables.
  const candidates: Array<{ entityType: ExternalEntityType; databaseId: string | null }> = [
    { entityType: "client" as ExternalEntityType, databaseId: cfg.clientsDbId ?? null },
  ];
  for (const { entityType, databaseId } of candidates) {
    if (!databaseId || existing.has(entityType)) continue;
    store.upsertExternalBinding(
      {
        agencyId,
        provider: NOTION_PROVIDER,
        entityType,
        externalDatabaseId: databaseId,
        externalDatabaseName: null,
        schema: null,
        syncDirection: "bidirectional",
      },
      actorId,
    );
  }
}

function monthWindow(now = new Date()): { startAt: number; endAt: number } {
  return {
    startAt: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    endAt: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
  };
}

async function parsedInvoiceFromParams(params: Record<string, unknown>) {
  const sourceBase64 = optionalString(params.sourceBase64);
  if (sourceBase64 && sourceBase64.length > 14_000_000) {
    throw new Error("invoice document exceeds the 10 MB limit");
  }
  const sourceText = await extractInvoiceText({
    sourceText: optionalString(params.sourceText),
    sourceBase64,
    mediaType: optionalString(params.mediaType),
  });
  const structured =
    params.structured && typeof params.structured === "object" ? params.structured : undefined;
  if (!sourceText.trim() && structured === undefined) throw new Error("invoice document is empty");
  return {
    sourceText: sourceText || JSON.stringify(structured),
    parsed: parseInvoice({ text: sourceText, structured }),
  };
}

function slugify(name: string, actorId: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agency";
  const suffix = createHash("sha256").update(`${actorId}:${Date.now()}`).digest("hex").slice(0, 6);
  return `${base}-${suffix}`;
}

function membershipRole(agencyId: string, actorId: string): AgencyRole | null {
  return (
    operationsStore()
      .listAgencyMembers(agencyId)
      .find((member) => member.userId === actorId)?.role ?? null
  );
}

function requireAccess(
  opts: GatewayRequestHandlerOptions,
  agencyId: string,
  allowed: AgencyRole[] = ["owner", "admin", "member", "viewer"],
): Actor {
  const actor = actorFor(opts);
  const role = membershipRole(agencyId, actor.id);
  if (!role) throw new Error("agency membership required");
  if (!allowed.includes(role)) throw new Error("insufficient agency role");
  return actor;
}

async function run(
  opts: GatewayRequestHandlerOptions,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    opts.respond(true, await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const forbidden = /membership|required|insufficient|forbidden/i.test(message);
    opts.respond(false, undefined, {
      code: forbidden ? "FORBIDDEN" : "INVALID_REQUEST",
      message,
    });
  }
}

async function secureDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safe =
      /^(invalid backup id|backup integrity verification failed|backup schema is newer than this runtime|restore plan not found|restore plan expired|restore confirmation did not match|staged restore integrity verification failed|maxCount must|maxAgeDays must|maxAgeHours must|restore ttl must)/.test(
        message,
      );
    throw new Error(safe ? message : "agency database operation failed");
  }
}

function bootstrapAgency(actor: Actor, name = "My Agency") {
  const store = operationsStore();
  const agency = store.createAgency({
    name,
    slug: slugify(name, actor.id),
    ownerUserId: actor.id,
  });
  seedAgencyAiWorkforce(workforceStore(), agency.id, actor.id);
  return agency;
}

async function agencyList(actor: Actor, opts?: GatewayRequestHandlerOptions) {
  let agencies = operationsStore().listAgenciesForUser(actor.id);
  const canMigrateLegacy =
    agencies.some((agency) => agency.role === "owner") ||
    (agencies.length === 0 && actor.id === "local-owner");
  const migration = canMigrateLegacy
    ? await migrateLegacyBusinessesToAgencies({
        stateDir: resolveStateDir(),
        actorId: actor.id,
        operationsStore: operationsStore(),
      })
    : await previewLegacyBusinessMigration({
        stateDir: resolveStateDir(),
        actorId: actor.id,
        operationsStore: operationsStore(),
      });
  agencies = operationsStore().listAgenciesForUser(actor.id);
  if (agencies.length === 0) {
    bootstrapAgency(actor);
    agencies = operationsStore().listAgenciesForUser(actor.id);
  }
  // Existing installs can already have agencies created by the legacy
  // migration or the default-store bootstrap without any workforce rows — and,
  // until routing landed, with zero SOPs and zero schedules, which is why a
  // "set up" agency could sit doing nothing. Bring every agency this owner/admin
  // can see up to the provisioning baseline. Recorded by version, so this is a
  // handful of indexed lookups and no writes once converged.
  for (const agency of agencies) {
    if (agency.role !== "owner" && agency.role !== "admin") continue;
    try {
      await ensureAgencyProvisioned(provisioningDeps(opts), agency.id, actor.id);
    } catch {
      // Provisioning must never stop an operator from seeing their agencies.
      seedAgencyAiWorkforce(workforceStore(), agency.id, actor.id);
    }
  }
  ensureReplicationLoop(actor);
  return {
    agencies: agencies.map((agency) => ({
      id: agency.id,
      name: agency.name,
      slug: agency.slug,
      role: agency.role,
      ownership: agency.ownership,
      ownerName: agency.ownership === "owned" ? actor.displayName : undefined,
      memberCount: operationsStore().listAgencyMembers(agency.id).length,
    })),
    migration,
  };
}

function pipelinePayload(agencyId: string) {
  const store = operationsStore();
  const clients = new Map(store.listClients(agencyId).map((client) => [client.id, client]));
  const stages: Array<{ id: OpportunityStage; label: string; color: string }> = [
    { id: "lead", label: "Lead", color: "#64748b" },
    { id: "qualified", label: "Qualified", color: "#3b82f6" },
    { id: "proposal", label: "Proposal", color: "#8b5cf6" },
    { id: "won", label: "Won", color: "#22c55e" },
    { id: "lost", label: "Lost", color: "#ef4444" },
  ];
  const opportunities = store.listOpportunities(agencyId);
  return {
    stages: stages.map((stage) => {
      const rows = opportunities.filter((opportunity) => opportunity.stage === stage.id);
      return {
        ...stage,
        dealCount: rows.length,
        value: rows.reduce((sum, row) => sum + row.valueCents, 0) / 100,
        weightedValue: rows.reduce((sum, row) => sum + row.valueCents * row.probability, 0) / 100,
      };
    }),
    deals: opportunities.map((opportunity) => ({
      id: opportunity.id,
      name: opportunity.name,
      clientName: clients.get(opportunity.clientId)?.name ?? "Unknown client",
      stageId: opportunity.stage,
      value: opportunity.valueCents / 100,
      probability: Math.round(opportunity.probability * 100),
      ownerName: opportunity.ownerId ?? undefined,
      nextActionAt: opportunity.expectedCloseAt ?? undefined,
    })),
  };
}

function employeePayload(agencyId: string) {
  const workforce = workforceStore();
  const departments = new Map(
    workforce.listDepartments(agencyId).map((department) => [department.id, department.name]),
  );
  const capacity = new Map(
    workforce.getWorkloadSummary(agencyId).map((item) => [item.workerId, item]),
  );
  const scorecards = new Map(
    workforce.getPerformanceScorecards(agencyId).map((item) => [item.workerId, item]),
  );
  return workforce.listWorkers(agencyId, { status: "active" }).map((worker) => {
    const cap = capacity.get(worker.id);
    const score = scorecards.get(worker.id);
    const performanceValues = [
      score?.qualityScore,
      score?.reliabilityScore,
      score?.collaborationScore,
    ].filter((value): value is number => typeof value === "number");
    return {
      id: worker.id,
      name: worker.displayName,
      kind: worker.type,
      role: worker.title,
      department: worker.departmentId
        ? (departments.get(worker.departmentId) ?? "Unknown")
        : "Unassigned",
      availability:
        worker.currentStatus === "blocked"
          ? "blocked"
          : worker.currentStatus === "offline"
            ? "offline"
            : worker.currentStatus === "focused"
              ? "focused"
              : "available",
      capacityHours: worker.weeklyCapacityHours,
      allocatedHours: cap?.allocatedHours ?? 0,
      utilizationPercent: cap?.utilizationPercent ?? 0,
      activeWork: workforce
        .listAssignments(agencyId)
        .filter(
          (assignment) =>
            ["planned", "active", "blocked", "review"].includes(assignment.status) &&
            assignment.members.some((member) => member.workerId === worker.id),
        ).length,
      performanceScore: performanceValues.length
        ? Math.round(
            (performanceValues.reduce((sum, value) => sum + value, 0) / performanceValues.length) *
              10,
          ) / 10
        : undefined,
      model: worker.type === "ai" ? (worker.agentId ?? undefined) : undefined,
      managerName: worker.managerWorkerId
        ? workforce.getWorker(agencyId, worker.managerWorkerId)?.displayName
        : undefined,
      persona: worker.persona,
      goals: worker.goals,
      kpis: worker.kpis,
      autonomyLevel: worker.autonomyLevel,
      approvalThreshold: worker.approvalThreshold,
    };
  });
}

// ── Invoice & proposal authoring ─────────────────────────────────────────────
//
// Money crosses this boundary as INTEGER CENTS, always. The older
// `agency.ops.invoices.payment.record` took dollars and multiplied by 100,
// which is exactly how a 1-cent rounding error gets into a ledger; every
// parameter below is named `*Cents` and is rejected unless it is an integer.

/** A whole number of cents. Rejects floats outright rather than rounding them. */
function centsParam(value: unknown, name: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number of cents`);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number of cents`);
  return value;
}

function optionalCents(value: unknown, name: string): number | undefined {
  return value === undefined || value === null ? undefined : centsParam(value, name);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineItemsParam(value: unknown, name = "lineItems"): InvoiceLineItemInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const quantity = typeof item.quantity === "number" ? item.quantity : 1;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`${name}[${index}].quantity must be a positive number`);
    }
    return {
      description: stringParam(item.description, `${name}[${index}].description`),
      quantity,
      unitPriceCents: centsParam(item.unitPriceCents, `${name}[${index}].unitPriceCents`),
      cadence: optionalString(item.cadence) as InvoiceLineItemInput["cadence"],
    };
  });
}

function proposalLineItemsParam(
  value: unknown,
): Array<{ description: string; quantity: number; unitPriceCents: number }> {
  return lineItemsParam(value).map(({ description, quantity, unitPriceCents }) => ({
    description,
    quantity,
    unitPriceCents,
  }));
}

function sectionsParam(value: unknown): ProposalSectionRecord[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("sections must be an array");
  return value.map((raw) => {
    const section = (raw ?? {}) as Record<string, unknown>;
    return {
      heading: String(section.heading ?? "").trim(),
      body: String(section.body ?? "").trim(),
    };
  });
}

/** Project links: `["id", …]` or `[{ projectId, allocationCents }, …]`. */
function projectLinksParam(
  value: unknown,
): Array<string | { projectId: string; allocationCents?: number }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("projectIds must be an array");
  return value.map((entry, index) => {
    if (typeof entry === "string") return entry;
    const link = (entry ?? {}) as Record<string, unknown>;
    return {
      projectId: stringParam(link.projectId, `projectIds[${index}].projectId`),
      allocationCents: optionalCents(link.allocationCents, `projectIds[${index}].allocationCents`),
    };
  });
}

const PROPOSAL_STATUSES: ProposalStatus[] = [
  "draft",
  "internal_review",
  "sent",
  "accepted",
  "rejected",
  "expired",
];

function proposalStatusParam(value: unknown): ProposalStatus {
  const status = stringParam(value, "status");
  if (!PROPOSAL_STATUSES.includes(status as ProposalStatus)) {
    throw new Error(`status must be one of ${PROPOSAL_STATUSES.join(", ")}`);
  }
  return status as ProposalStatus;
}

/**
 * Build the render-ready invoice model from the store.
 *
 * This happens gateway-side on purpose: the resulting model is plain JSON that
 * travels to the render worker inside `config.document`, which is what keeps
 * the worker process from ever opening `agency.db`.
 */
/**
 * Whop credentials or a clean, actionable failure.
 *
 * `run` maps a thrown Error to INVALID_REQUEST with the message intact, so an
 * install with no key gets "Whop API key not configured — …" rather than a
 * stack trace or a silent no-op. The key itself is returned to the caller of
 * this function only, never to the RPC response.
 */
function whopCredentialsOrThrow(params: Record<string, unknown>): {
  apiKey: string;
  companyId: string;
} {
  const resolved = resolveWhopCredentials(params);
  if (!resolved.ok) throw new Error(resolved.message);
  return { apiKey: resolved.apiKey, companyId: resolved.companyId };
}

/**
 * The link as the UI may see it. `reference` is deliberately withheld: it is
 * the shared secret that makes a metadata match positive evidence, and leaking
 * it into a client-visible payload would let someone forge one.
 */
function publicPaymentLink(link: InvoicePaymentLink) {
  const { reference: _reference, ...rest } = link;
  return rest;
}

/**
 * What goes in the document's payment-link slot.
 *
 * Precedence: an explicit `paymentLink` param still wins (an operator pasting
 * a one-off URL keeps working), then the link stored against the invoice, then
 * nothing. This is what turns "PAYMENT LINK TO FOLLOW" into a real URL without
 * anyone pasting anything.
 */
function resolveDocumentPaymentLink(
  agencyId: string,
  invoiceId: string,
  params: Record<string, unknown>,
): { url: string; label: string | null } | null {
  const pasted = optionalString(params.paymentLink);
  if (pasted) {
    return { url: pasted, label: optionalString(params.paymentLinkLabel) ?? null };
  }
  const stored = operationsStore().getInvoicePaymentLink(agencyId, invoiceId);
  if (!stored) return null;
  return {
    url: stored.url,
    label: optionalString(params.paymentLinkLabel) ?? stored.label,
  };
}

function invoiceDocumentModelFor(
  agencyId: string,
  invoiceId: string,
  overrides: {
    theme?: string;
    asOf?: number;
    reference?: string;
    notes?: string;
    paymentTerms?: string;
    paymentLink?: { url?: string | null; label?: string | null } | null;
  } = {},
): { model: InvoiceDocumentModel; clientId: string; projectIds: string[] } {
  const store = operationsStore();
  const detail = store.getInvoiceDetail(agencyId, invoiceId);
  if (!detail) throw new Error("invoice not found");
  const client = store.getClient(detail.invoice.clientId, agencyId);
  if (!client) throw new Error("invoice references a missing client");
  const contact = store.listClientContacts(agencyId, client.id)[0] ?? null;
  const projects = detail.projectLinks
    .map((link) => store.getProject(agencyId, link.projectId))
    .filter((project): project is NonNullable<typeof project> => Boolean(project));
  // The saved bank / payment option, if the invoice references one, mapped to
  // the presentation shape the document template prints.
  const account = detail.invoice.paymentAccountId
    ? store.getPaymentAccount(agencyId, detail.invoice.paymentAccountId)
    : null;
  const bankDetails = account
    ? {
        label: account.label,
        bankName: account.bankName,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        iban: account.iban,
        swift: account.swift,
        routingNumber: account.routingNumber,
        instructions: account.instructions,
      }
    : null;
  return {
    clientId: client.id,
    projectIds: projects.map((project) => project.id),
    model: buildInvoiceDocumentModel({
      invoice: detail.invoice,
      client,
      contact,
      lineItems: detail.lineItems,
      payments: detail.payments,
      profile: store.getAgencyProfile(agencyId),
      agencyName: store.getAgency(agencyId)?.name ?? null,
      projects: projects.map((project) => project.name),
      theme: overrides.theme ?? DEFAULT_DOCUMENT_THEME,
      reference: overrides.reference ?? detail.invoice.reference,
      notes: overrides.notes ?? detail.invoice.notes,
      paymentTerms: overrides.paymentTerms ?? detail.invoice.terms,
      paymentLink: overrides.paymentLink ?? null,
      bankDetails,
      taxLabel: detail.invoice.taxLabel,
      asOf: overrides.asOf ?? Date.now(),
    }),
  };
}

function proposalDocumentModelFor(
  agencyId: string,
  proposalId: string,
  overrides: {
    theme?: string;
    asOf?: number;
    number?: string;
    summary?: string;
    sections?: ProposalSectionRecord[];
    acceptanceTerms?: string[];
    notes?: string;
  } = {},
): { model: ProposalDocumentModel; clientId: string | null } {
  const store = operationsStore();
  const proposal = store.getProposal(proposalId, agencyId);
  if (!proposal) throw new Error("proposal not found");
  const clientId =
    proposal.clientId ?? store.getOpportunity(proposal.opportunityId, agencyId)?.clientId ?? null;
  const client = clientId ? store.getClient(clientId, agencyId) : null;
  if (!client) throw new Error("proposal references a missing client");
  const contact = store.listClientContacts(agencyId, client.id)[0] ?? null;
  return {
    clientId: client.id,
    model: buildProposalDocumentModel({
      proposal,
      client,
      contact,
      profile: store.getAgencyProfile(agencyId),
      agencyName: store.getAgency(agencyId)?.name ?? null,
      theme: overrides.theme ?? DEFAULT_DOCUMENT_THEME,
      number: overrides.number ?? proposal.number,
      summary: overrides.summary ?? proposal.summary,
      sections: overrides.sections ?? proposal.sections,
      acceptanceTerms:
        overrides.acceptanceTerms ??
        (proposal.acceptanceTerms.length ? proposal.acceptanceTerms : undefined),
      notes: overrides.notes,
      asOf: overrides.asOf ?? Date.now(),
    }),
  };
}

/**
 * One historical invoice row, shared by the single-entry and bulk backlog
 * endpoints so a CSV import and a hand-typed entry are validated identically.
 *
 * `issuedAt` is mandatory — a backlog row without a date is precisely the thing
 * that would dump last year's revenue into this month.
 */
function backlogRowParam(params: Record<string, unknown>) {
  const issuedAt = optionalNumber(params.issuedAt);
  if (issuedAt === undefined) throw new Error("issuedAt is required for a backlogged invoice");
  const payments = Array.isArray(params.payments)
    ? params.payments.map((raw, index) => {
        const payment = (raw ?? {}) as Record<string, unknown>;
        const paidAt = optionalNumber(payment.paidAt);
        if (paidAt === undefined) throw new Error(`payments[${index}].paidAt is required`);
        return {
          amountCents: centsParam(payment.amountCents, `payments[${index}].amountCents`),
          paidAt,
          method: optionalString(payment.method),
          reference: optionalString(payment.reference),
        };
      })
    : undefined;
  return {
    clientId: stringParam(params.clientId, "clientId"),
    issuedAt,
    dueAt: optionalNumber(params.dueAt),
    number: optionalString(params.number),
    currency: optionalString(params.currency),
    engagementId: optionalString(params.engagementId),
    proposalId: optionalString(params.proposalId),
    taxCents: optionalCents(params.taxCents, "taxCents"),
    taxLabel: optionalString(params.taxLabel),
    reference: optionalString(params.reference),
    notes: optionalString(params.notes),
    terms: optionalString(params.terms),
    projectIds: stringListParam(params.projectIds),
    lineItems: lineItemsParam(params.lineItems),
    payments,
    // `paidInFull: true` with no explicit date settles it on the issue date,
    // which is the common shape of a historical cash-basis entry.
    paidInFullAt:
      params.paidInFull === true
        ? (optionalNumber(params.paidAt) ?? issuedAt)
        : optionalNumber(params.paidInFullAt),
  };
}

/** Sinks param for a document render; defaults to the in-app report list only. */
function sinksParam(value: unknown): string[] {
  const sinks = stringListParam(value);
  return sinks.length ? sinks : ["ui"];
}

export const agencyOperationsHandlers: GatewayRequestHandlers = {
  "agency.ops.agencies.list": async (opts) => run(opts, () => agencyList(actorFor(opts), opts)),

  "agency.ops.replication.status": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const satellite = getFederationSatellite();
      const status = operationsStore().getReplicationStatus(agencyId, localReplicationNodeId());
      if (satellite && satellite.getState() !== "connected" && status.state !== "offline") {
        return { status: { ...status, state: "offline", pending: true } };
      }
      return { status };
    }),

  "agency.ops.replication.export": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        snapshot: operationsStore().exportReplicationSnapshot(
          agencyId,
          optionalString(opts.params.sourceNodeId) ?? localReplicationNodeId(),
        ),
      };
    }),

  "agency.ops.replication.merge": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const snapshot = opts.params.snapshot;
      if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot is required");
      if ((snapshot as { agencyId?: unknown }).agencyId !== agencyId) {
        throw new Error("snapshot agency scope mismatch");
      }
      return {
        merge: operationsStore().mergeReplicationSnapshot(
          snapshot as Parameters<ReturnType<typeof operationsStore>["mergeReplicationSnapshot"]>[0],
          localReplicationNodeId(),
        ),
      };
    }),

  "agency.ops.replication.sync": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return syncAgencyWithMaster(agencyId);
    }),

  "agency.ops.replication.conflicts.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        conflicts: operationsStore().listReplicationConflicts(
          agencyId,
          numberParam(opts.params.limit, 100),
        ),
      };
    }),

  "agency.ops.migration.preview": async (opts) =>
    run(opts, () =>
      previewLegacyBusinessMigration({
        stateDir: resolveStateDir(),
        actorId: actorFor(opts).id,
        operationsStore: operationsStore(),
      }),
    ),

  "agency.ops.migration.run": async (opts) =>
    run(opts, () => {
      const actor = actorFor(opts);
      const ownsAgency = operationsStore()
        .listAgenciesForUser(actor.id)
        .some((agency) => agency.role === "owner");
      if (!ownsAgency && actor.id !== "local-owner") {
        throw new Error("agency owner role required to migrate legacy data");
      }
      return migrateLegacyBusinessesToAgencies({
        stateDir: resolveStateDir(),
        actorId: actor.id,
        operationsStore: operationsStore(),
        force: true,
      });
    }),

  "agency.ops.agency.create": async (opts) =>
    run(opts, () => {
      const actor = actorFor(opts);
      const name = stringParam(opts.params.name, "name");
      const agency = bootstrapAgency(actor, name);
      ensureLegacyBusinessMirror({
        stateDir: resolveStateDir(),
        agencyId: agency.id,
        name: agency.name,
      });
      return { agency: { ...agency, role: "owner", ownership: "owned", memberCount: 1 } };
    }),

  "agency.ops.agency.share": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const email = stringParam(opts.params.email, "email").toLowerCase();
      const role = stringParam(opts.params.role, "role") as Exclude<AgencyRole, "owner">;
      if (!["admin", "member", "viewer"].includes(role)) throw new Error("invalid invitation role");
      const invitation = operationsStore().createAgencyInvitation(
        { agencyId, email, role, expiresAt: Date.now() + 7 * 86_400_000 },
        actor.id,
      );
      const status = await collaboration.enable(resolveGatewayPort());
      const joinUrl =
        status.state === "ready" && status.collaborationUrl
          ? collaboration.buildJoinUrl({
              baseUrl: status.collaborationUrl,
              invitationToken: invitation.token,
              path: "/agency-operations",
            })
          : null;
      return {
        invitation: { ...invitation.invitation, tokenHash: undefined },
        joinUrl,
        collaboration: status,
      };
    }),

  "agency.ops.agency.invite.accept": async (opts) =>
    run(opts, () => {
      const actor = actorFor(opts);
      const token = stringParam(opts.params.token, "token");
      const email = actor.email;
      if (!email) throw new Error("A verified email is required to accept this invitation");
      const membership = operationsStore().acceptAgencyInvitation(token, actor.id, email);
      return { membership };
    }),

  "agency.ops.collaboration.status": async (opts) =>
    run(opts, () => collaboration.getStatus(resolveGatewayPort())),

  "agency.ops.collaboration.enable": async (opts) =>
    run(opts, () => collaboration.enable(resolveGatewayPort())),

  "agency.ops.database.health": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() => resilience().getHealth());
    }),

  "agency.ops.database.schema.status": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() => resilience().getSchemaStatus());
    }),

  "agency.ops.database.backups.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience()
          .listBackups()
          .then((backups) => ({ backups })),
      );
    }),

  "agency.ops.database.backup.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience()
          .createBackup()
          .then((backup) => ({ backup })),
      );
    }),

  "agency.ops.database.backup.ensure": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience().ensureBackup(numberParam(opts.params.maxAgeHours, 24)),
      );
    }),

  "agency.ops.database.backup.verify": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience()
          .verifyBackup(stringParam(opts.params.backupId, "backupId"))
          .then((backup) => ({ backup })),
      );
    }),

  "agency.ops.database.backups.prune": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience().pruneBackups({
          maxCount: numberParam(opts.params.maxCount, 14),
          maxAgeDays: numberParam(opts.params.maxAgeDays, 30),
        }),
      );
    }),

  "agency.ops.database.restore.prepare": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience().prepareRestore(stringParam(opts.params.backupId, "backupId")),
      );
    }),

  "agency.ops.database.restore.cancel": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience().cancelRestore(stringParam(opts.params.restoreId, "restoreId")),
      );
    }),

  "agency.ops.database.restore.activate": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return secureDatabaseOperation(() =>
        resilience().activateRestore(
          stringParam(opts.params.restoreId, "restoreId"),
          stringParam(opts.params.confirmation, "confirmation"),
        ),
      );
    }),

  "agency.ops.dashboard": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const summary = operationsStore().businessSummary(agencyId);
      const workforce = workforceStore().getDepartmentCapacity(agencyId);
      return {
        dashboard: {
          summary,
          kpis: [
            {
              id: "cash-collected-total",
              label: "Total cash collected",
              value: `$${Math.round(summary.collectedCents / 100).toLocaleString()}`,
              context: "All-time payments received",
            },
            {
              id: "clients",
              label: "Active clients",
              value: String(summary.activeClients),
              context: `${summary.activeEngagements} active engagements`,
            },
            {
              id: "receivables",
              label: "Receivables",
              value: `$${Math.round(summary.outstandingInvoicesCents / 100).toLocaleString()}`,
              context: `$${Math.round(summary.overdueInvoicesCents / 100).toLocaleString()} overdue`,
              tone: summary.overdueInvoicesCents ? "warning" : "neutral",
            },
            {
              id: "capacity",
              label: "Team capacity",
              value: `${Math.round(workforce.reduce((sum, row) => sum + row.remainingHours, 0))}h`,
              context: "remaining this week",
            },
          ],
        },
      };
    }),

  "agency.ops.pipeline.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return { pipeline: pipelinePayload(agencyId) };
    }),

  "agency.ops.pipeline.deal.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const clientName = stringParam(opts.params.clientName, "clientName");
      const store = operationsStore();
      const client =
        store
          .listClients(agencyId)
          .find((item) => item.name.toLowerCase() === clientName.toLowerCase()) ??
        store.createClient({ name: clientName }, { agencyId, actorId: actor.id });
      const opportunity = store.createOpportunity(
        {
          clientId: client.id,
          name: stringParam(opts.params.name, "name"),
          valueCents: cents(opts.params.value),
        },
        { agencyId, actorId: actor.id },
      );
      const requestedStage = optionalString(opts.params.stageId) as OpportunityStage | undefined;
      const deal =
        requestedStage && requestedStage !== "lead"
          ? store.transitionOpportunity(opportunity.id, requestedStage, undefined, {
              agencyId,
              actorId: actor.id,
            })
          : opportunity;
      return { deal };
    }),

  "agency.ops.engagements.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = operationsStore();
      const clients = new Map(store.listClients(agencyId).map((client) => [client.id, client]));
      const status = optionalString(opts.params.status) as EngagementStatus | undefined;
      return {
        engagements: store.listEngagements(agencyId, status).map((engagement) => {
          const deliverables = store.listDeliverables(agencyId, engagement.id);
          const approved = deliverables.filter((item) => item.status === "approved").length;
          return {
            id: engagement.id,
            clientName: clients.get(engagement.clientId)?.name ?? "Unknown client",
            name: engagement.name,
            health: "on_track",
            progress: deliverables.length ? Math.round((approved / deliverables.length) * 100) : 0,
            budgetUsedPercent: 0,
            dueAt: engagement.targetEndAt ?? undefined,
            deliverables: deliverables.map((item) => ({
              id: item.id,
              name: item.name,
              status:
                item.status === "backlog"
                  ? "planned"
                  : item.status === "review" || item.status === "client_review"
                    ? "in_review"
                    : item.status,
              dueAt: item.dueAt ?? undefined,
              ownerName: item.assigneeId ?? undefined,
            })),
          };
        }),
      };
    }),

  "agency.ops.engagement.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const store = operationsStore();
      const clientName = stringParam(opts.params.clientName, "clientName");
      const client =
        store
          .listClients(agencyId)
          .find((item) => item.name.toLowerCase() === clientName.toLowerCase()) ??
        store.createClient({ name: clientName }, { agencyId, actorId: actor.id });
      const engagement = store.createEngagement(
        {
          clientId: client.id,
          name: stringParam(opts.params.name, "name"),
          budgetCents: cents(opts.params.budget),
          targetEndAt: numberParam(opts.params.dueAt) || undefined,
        },
        { agencyId, actorId: actor.id },
      );
      return {
        engagement: store.transitionEngagement(engagement.id, "active", {
          agencyId,
          actorId: actor.id,
        }),
      };
    }),

  "agency.ops.approvals.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = operationsStore();
      const status = optionalString(opts.params.status) === "pending" ? "requested" : undefined;
      const engagements = new Map(
        store.listEngagements(agencyId).map((engagement) => [engagement.id, engagement]),
      );
      return {
        approvals: store.listApprovals(agencyId, status).map((approval) => ({
          id: approval.id,
          type: "deliverable",
          title: approval.deliverableId ? "Client deliverable approval" : "Client approval",
          description: approval.note ?? undefined,
          requestedBy: "Agency team",
          requestedAt: approval.createdAt,
          risk: "medium",
          engagementName: engagements.get(approval.engagementId)?.name,
        })),
      };
    }),

  "agency.ops.approval.resolve": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const decision = stringParam(opts.params.decision, "decision");
      if (decision !== "approved" && decision !== "rejected") throw new Error("invalid decision");
      return {
        approval: operationsStore().decideClientApproval(
          stringParam(opts.params.approvalId, "approvalId"),
          decision,
          undefined,
          { agencyId, actorId: actor.id },
        ),
      };
    }),

  "agency.ops.employees.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId);
      const role = membershipRole(agencyId, actor.id);
      if (role === "owner" || role === "admin") {
        seedAgencyAiWorkforce(workforceStore(), agencyId, actor.id);
      }
      return { employees: employeePayload(agencyId) };
    }),

  "agency.ops.employee.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const workforce = workforceStore();
      const departmentName = optionalString(opts.params.department) ?? "Unassigned";
      let department = workforce
        .listDepartments(agencyId)
        .find((item) => item.name.toLowerCase() === departmentName.toLowerCase());
      if (!department && departmentName !== "Unassigned") {
        department = workforce.createDepartment(
          agencyId,
          { name: departmentName, description: `${departmentName} team` },
          actor.id,
        );
      }
      const kind = stringParam(opts.params.kind, "kind");
      if (kind !== "human" && kind !== "ai") throw new Error("kind must be human or ai");
      const employee = workforce.createWorker(
        {
          agencyId,
          type: kind,
          displayName: stringParam(opts.params.name, "name"),
          title: stringParam(opts.params.role, "role"),
          departmentId: department?.id,
          weeklyCapacityHours: numberParam(opts.params.capacityHours, kind === "ai" ? 168 : 40),
          persona: optionalString(opts.params.persona),
          autonomyLevel: kind === "ai" ? 1 : 0,
          currentStatus: "available",
        },
        actor.id,
      );
      return { employee };
    }),

  "agency.ops.employee.capacity.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const employee = workforceStore().updateWorker(
        agencyId,
        stringParam(opts.params.employeeId, "employeeId"),
        { weeklyCapacityHours: numberParam(opts.params.capacityHours) },
        actor.id,
      );
      if (!employee) throw new Error("employee not found");
      return { employee };
    }),

  "agency.ops.employee.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const workforce = workforceStore();
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const current = workforce.getWorker(agencyId, employeeId);
      if (!current) throw new Error("employee not found");

      const patch: Parameters<typeof workforce.updateWorker>[2] = {};
      const name = optionalString(opts.params.name);
      if (name) patch.displayName = name;
      const role = optionalString(opts.params.role);
      if (role) patch.title = role;

      const departmentName = optionalString(opts.params.department);
      if (departmentName) {
        if (departmentName.toLowerCase() === "unassigned") {
          patch.departmentId = null;
        } else {
          const department =
            workforce
              .listDepartments(agencyId)
              .find((item) => item.name.toLowerCase() === departmentName.toLowerCase()) ??
            workforce.createDepartment(
              agencyId,
              { name: departmentName, description: `${departmentName} team` },
              actor.id,
            );
          patch.departmentId = department.id;
        }
      }

      if ("managerWorkerId" in opts.params) {
        const managerWorkerId = optionalString(opts.params.managerWorkerId) ?? null;
        if (managerWorkerId) {
          if (managerWorkerId === employeeId) throw new Error("employee cannot manage themselves");
          if (!workforce.getWorker(agencyId, managerWorkerId)) throw new Error("manager not found");
        }
        patch.managerWorkerId = managerWorkerId;
      }

      if (typeof opts.params.capacityHours === "number") {
        patch.weeklyCapacityHours = numberParam(opts.params.capacityHours);
      }
      if (typeof opts.params.availabilityPercent === "number") {
        patch.availabilityPercent = numberParam(opts.params.availabilityPercent);
      }
      const status = optionalString(opts.params.status);
      if (status) patch.currentStatus = status;
      const employmentStatus = optionalString(opts.params.employmentStatus);
      if (employmentStatus) {
        if (!EMPLOYMENT_STATUSES.includes(employmentStatus as EmploymentStatus)) {
          throw new Error(`employmentStatus must be one of ${EMPLOYMENT_STATUSES.join(", ")}`);
        }
        patch.employmentStatus = employmentStatus as EmploymentStatus;
      }
      const persona = optionalString(opts.params.persona);
      if (persona) patch.persona = persona;
      const modelBinding = optionalString(opts.params.modelBinding);
      if (modelBinding) patch.modelBinding = modelBinding;
      if (typeof opts.params.autonomyLevel === "number") {
        const level = Math.trunc(opts.params.autonomyLevel);
        if (level < 0 || level > 3) throw new Error("autonomyLevel must be between 0 and 3");
        patch.autonomyLevel = level as 0 | 1 | 2 | 3;
      }

      if (Object.keys(patch).length === 0) throw new Error("no updatable fields provided");
      const employee = workforce.updateWorker(agencyId, employeeId, patch, actor.id);
      if (!employee) throw new Error("employee not found");
      return { employee };
    }),

  "agency.ops.employee.deactivate": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const requested = optionalString(opts.params.employmentStatus) ?? "inactive";
      if (!DEACTIVATION_STATUSES.includes(requested as EmploymentStatus)) {
        throw new Error(`employmentStatus must be one of ${DEACTIVATION_STATUSES.join(", ")}`);
      }
      const workforce = workforceStore();
      if (!workforce.getWorker(agencyId, employeeId)) throw new Error("employee not found");
      const employee = workforce.updateWorker(
        agencyId,
        employeeId,
        { employmentStatus: requested as EmploymentStatus, currentStatus: "offline" },
        actor.id,
      );
      if (!employee) throw new Error("employee not found");
      return { employee };
    }),

  "agency.ops.finance.summary": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const summary = operationsStore().businessSummary(agencyId);
      const period = monthWindow();
      const revenueSummary = operationsStore().revenueSummary(
        agencyId,
        period.startAt,
        period.endAt,
      );
      const workers = workforceStore().listWorkers(agencyId, { status: "active" });
      const payrollMonth = workers
        .filter((worker) => worker.type === "human")
        .reduce((sum, worker) => sum + (worker.costRate * worker.weeklyCapacityHours * 52) / 12, 0);
      const aiSpendMonth = workers
        .filter((worker) => worker.type === "ai")
        .reduce((sum, worker) => sum + (worker.costRate * worker.weeklyCapacityHours * 52) / 12, 0);
      const revenue = revenueSummary.invoicedRevenueCents / 100;
      const operatingCost = payrollMonth + aiSpendMonth;
      // Fold per-project MRR (set on the /projects header popover) into the
      // headline MRR/ARR figures. See kanbanProjectsMrrCents().
      const mrrCents = revenueSummary.mrrCents + kanbanProjectsMrrCents();
      return {
        finance: {
          currency: revenueSummary.currency,
          revenueMonth: revenue,
          cashCollectedMonth: revenueSummary.collectedRevenueCents / 100,
          mrr: mrrCents / 100,
          arr: (mrrCents * 12) / 100,
          activeMrrClients: revenueSummary.activeMrrClients,
          averageRevenuePerClient: revenueSummary.averageRevenuePerClientCents / 100,
          revenueTarget: 0,
          contractedBacklog: summary.wonRevenueCents / 100,
          outstandingReceivables: summary.outstandingInvoicesCents / 100,
          overdueReceivables: summary.overdueInvoicesCents / 100,
          grossMarginPercent: revenue
            ? Math.round(((revenue - operatingCost) / revenue) * 1000) / 10
            : 0,
          operatingExpensesMonth: operatingCost,
          aiSpendMonth,
          payrollMonth,
        },
      };
    }),

  "agency.ops.invoices.parse": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const { parsed } = await parsedInvoiceFromParams(opts.params);
      return { parsed };
    }),

  "agency.ops.invoices.ingest": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const { parsed, sourceText } = await parsedInvoiceFromParams(opts.params);
      if (parsed.confidence < 0.55 || parsed.warnings.length > 0) {
        const confirmed = opts.params.confirmWarnings === true;
        if (!confirmed) {
          const financeWorker = workforceStore()
            .listWorkers(agencyId, { status: "active" })
            .find((worker) => worker.agentId === "finance" || /finance/i.test(worker.title));
          const financeReview = financeWorker
            ? workforceOperatingStore().enqueueWorkItem(agencyId, {
                workerId: financeWorker.id,
                managerWorkerId: financeWorker.managerWorkerId,
                title: `Review invoice ${parsed.invoiceNumber || "with missing number"}`,
                instructions:
                  "Validate the parser warnings, client/project attribution, total, payment status, and recurring revenue before an operator confirms this invoice.",
                priority: "high",
                idempotencyKey: `invoice-review:${parsed.sourceHash}`,
                context: {
                  sourceName: optionalString(opts.params.sourceName),
                  invoiceNumber: parsed.invoiceNumber,
                  clientName: parsed.clientName,
                  projectName: parsed.projectName,
                  totalCents: parsed.totalCents,
                  recurringMonthlyCents: parsed.recurringMonthlyCents,
                  confidence: parsed.confidence,
                  warnings: parsed.warnings,
                },
              })
            : null;
          return { requiresConfirmation: true, parsed, financeReview };
        }
      }
      const result = operationsStore().ingestParsedInvoice(
        parsed,
        {
          sourceText,
          sourceName: optionalString(opts.params.sourceName),
          projectId: optionalString(opts.params.projectId),
          clientId: optionalString(opts.params.clientId),
        },
        { agencyId, actorId: actor.id },
      );
      syncCanonicalAgencyRevenue(agencyId);
      return {
        requiresConfirmation: false,
        result,
      };
    }),

  "agency.ops.invoices.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const clients = new Map(
        operationsStore()
          .listClients(agencyId)
          .map((client) => [client.id, client.name]),
      );
      const projects = new Map(
        operationsStore()
          .listProjects(agencyId)
          .map((project) => [project.id, project.name]),
      );
      const status = optionalString(opts.params.status) as InvoiceStatus | undefined;
      return {
        invoices: operationsStore()
          .listInvoices(agencyId, status)
          .map((invoice) => ({
            ...invoice,
            clientName: clients.get(invoice.clientId) ?? "Unknown client",
            lineItems: operationsStore().listInvoiceLineItems(agencyId, invoice.id),
            projects: operationsStore()
              .listInvoiceProjectLinks(agencyId, invoice.id)
              .map((link) => ({
                ...link,
                projectName: projects.get(link.projectId) ?? "Unknown project",
              })),
          })),
      };
    }),

  /**
   * Record a payment against an invoice.
   *
   * `amountCents` is the correct parameter and takes precedence. `amount`
   * (dollars) is still honoured for the existing UI call site, but it is the
   * lossy one — a partial payment of $33.335 cannot be expressed in it.
   * Partial payments and historical `paidAt` values are both supported: the
   * revenue entry is recognised at `paidAt`, not at the time of the call.
   */
  "agency.ops.invoices.payment.record": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const amountCents =
        optionalCents(opts.params.amountCents, "amountCents") ?? cents(opts.params.amount);
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const payment = operationsStore().recordPayment(
        invoiceId,
        {
          amountCents,
          paidAt: numberParam(opts.params.paidAt, Date.now()),
          method: optionalString(opts.params.method),
          reference: optionalString(opts.params.reference),
        },
        { agencyId, actorId: actor.id },
      );
      syncCanonicalAgencyRevenue(agencyId);
      return { payment, invoice: operationsStore().getInvoice(invoiceId, agencyId) };
    }),

  // ── Hosted payment links (Whop) ────────────────────────────────────────────

  /**
   * Create a Whop hosted checkout for this invoice's outstanding balance and
   * bind it to the invoice, so `invoice.document.render` stops needing a
   * pasted URL.
   *
   * Refuses to replace a live link unless `regenerate: true` — a client may
   * already be holding the old one, and quietly minting a second link for a
   * different amount is how an agency ends up double-charged.
   */
  "agency.ops.invoice.paymentLink.create": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const store = operationsStore();
      const invoice = store.getInvoice(invoiceId, agencyId);
      if (!invoice) throw new Error("invoice not found");
      const regenerate = opts.params.regenerate === true;
      const existing = store.getInvoicePaymentLink(agencyId, invoiceId);
      if (existing && !regenerate) {
        throw new Error(
          "this invoice already has a payment link — pass regenerate: true to replace it",
        );
      }
      // Charge what is actually still owed, not the face value: regenerating a
      // link after a part payment must not re-bill the paid portion.
      const amountCents =
        optionalCents(opts.params.amountCents, "amountCents") ?? invoice.balanceCents;
      if (amountCents <= 0) throw new Error("invoice has no outstanding balance to charge");

      const credentials = whopCredentialsOrThrow(opts.params);
      const transport = createWhopTransport(credentials.apiKey);
      // 32 hex chars of CSPRNG. This is the token we push into Whop's checkout
      // metadata and demand back as positive evidence; it must not be guessable
      // by anyone who can see an invoice number.
      const reference = randomBytes(16).toString("hex");
      const client = store.getClient(invoice.clientId, agencyId);
      const link = await createWhopCheckoutLink(transport, {
        companyId: credentials.companyId,
        amountCents,
        currency: invoice.currency,
        title: `Invoice ${invoice.number}`,
        description: client ? `Invoice ${invoice.number} — ${client.name}` : undefined,
        reference,
        invoiceId,
        redirectUrl: optionalString(opts.params.redirectUrl) ?? null,
      });
      const stored = store.upsertInvoicePaymentLink(
        {
          invoiceId,
          provider: WHOP_PROVIDER,
          externalId: link.id,
          url: link.purchaseUrl,
          label: optionalString(opts.params.label) ?? "Pay online",
          reference,
          amountCents: link.amountCents,
          currency: link.currency,
          planId: link.planId,
        },
        { agencyId, actorId: actor.id },
      );
      return { link: publicPaymentLink(stored), replaced: Boolean(existing) };
    }),

  /**
   * Masked status of the payment credentials THIS node will spend.
   *
   * Lives under `agency.ops.` on purpose: `business.*` is proxied to master on
   * a satellite, so the Business page's income settings read and write the
   * master's store, while payment links are minted locally from the local
   * store. Anyone entering a key through the proxied surface would keep seeing
   * "Whop API key not configured" here. This pair is the local truth.
   */
  "agency.ops.payments.provider.get": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const { readLocalPaymentProviderStatus } = await import("./business-income.js");
      return readLocalPaymentProviderStatus(optionalString(opts.params.businessId));
    }),

  /**
   * Save the Whop key and/or company id for this node. Either field may be
   * omitted to leave it untouched, so the company id can be added later
   * without re-typing the key.
   */
  "agency.ops.payments.provider.set": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      // Credentials spend real money — same bar as issuing an invoice.
      requireAccess(opts, agencyId, ["owner", "admin"]);
      const { writeLocalPaymentProviderCredentials, readLocalPaymentProviderStatus } =
        await import("./business-income.js");
      const businessId = optionalString(opts.params.businessId);
      writeLocalPaymentProviderCredentials({
        businessId,
        whop: optionalString(opts.params.whop),
        whopCompanyId: optionalString(opts.params.whopCompanyId),
      });
      // Answer with the masked status so the surface repaints from truth
      // rather than from what was typed.
      return readLocalPaymentProviderStatus(businessId);
    }),

  /** The link currently bound to an invoice, if any. */
  "agency.ops.invoice.paymentLink.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const link = operationsStore().getInvoicePaymentLink(
        agencyId,
        stringParam(opts.params.invoiceId, "invoiceId"),
      );
      return { link: link ? publicPaymentLink(link) : null };
    }),

  /**
   * Unbind the link. `deleteRemote` (default true) also retires the checkout
   * at Whop so an old URL stops taking money; a remote failure is reported but
   * never blocks the local detach, because the operator's intent is that this
   * install stop treating the link as live.
   */
  "agency.ops.invoice.paymentLink.detach": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const store = operationsStore();
      const existing = store.getInvoicePaymentLink(agencyId, invoiceId);
      if (!existing) return { detached: false, remoteDeleted: false, remoteError: null };
      let remoteDeleted = false;
      let remoteError: string | null = null;
      if (opts.params.deleteRemote !== false) {
        const credentials = resolveWhopCredentials(opts.params);
        if (credentials.ok) {
          const outcome = await deleteWhopCheckoutLink(
            createWhopTransport(credentials.apiKey),
            existing.externalId,
          );
          remoteDeleted = outcome.deleted;
          remoteError = outcome.error ?? null;
        } else {
          remoteError = credentials.message;
        }
      }
      store.deleteInvoicePaymentLink(agencyId, invoiceId, { agencyId, actorId: actor.id });
      return { detached: true, remoteDeleted, remoteError };
    }),

  // ── Payment reconciliation ─────────────────────────────────────────────────

  /**
   * Pull Whop payments and settle the invoices they positively identify.
   *
   * `dryRun: true` runs the identical matching logic and writes nothing — the
   * preview an operator approves is exactly the run they get. Matching is
   * evidence-based (see `payment-reconciliation.ts`); `allowAmountMatch` opts
   * into the weaker exact-amount rule, which still refuses on any ambiguity.
   *
   * Idempotent: a Whop payment already carrying a receipt is skipped before
   * any work, so re-running writes zero rows.
   */
  "agency.ops.payments.reconcile": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const credentials = whopCredentialsOrThrow(opts.params);
      const payments = await listWhopPayments(createWhopTransport(credentials.apiKey), {
        companyId: credentials.companyId,
        since: optionalString(opts.params.since),
      });
      return reconcilePayments({
        store: operationsStore(),
        agencyId,
        actorId: actor.id,
        payments,
        dryRun: opts.params.dryRun === true,
        match: {
          allowAmountMatch: opts.params.allowAmountMatch === true,
          windowDays: optionalNumber(opts.params.windowDays),
        },
      });
    }),

  /**
   * Provider payments we refused to attach — the human-assignment queue.
   * Defaults to `unmatched`; pass `status` to inspect matched or ignored rows.
   */
  "agency.ops.payments.unmatched.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const status = (optionalString(opts.params.status) ??
        "unmatched") as ExternalPaymentReceiptStatus;
      if (!["matched", "unmatched", "ignored"].includes(status)) {
        throw new Error("status must be one of matched, unmatched, ignored");
      }
      const receipts = operationsStore().listExternalPaymentReceipts(agencyId, {
        status,
        limit: optionalNumber(opts.params.limit),
      });
      return {
        receipts,
        // The reason vocabulary, so the UI does not have to hard-code it.
        reasons: PAYMENT_MATCH_REASONS,
      };
    }),

  /** Attach an unmatched provider payment to an invoice, by hand. */
  "agency.ops.payments.unmatched.assign": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const { receipt, payment } = operationsStore().resolveExternalPaymentReceipt(
        agencyId,
        stringParam(opts.params.receiptId, "receiptId"),
        invoiceId,
        { agencyId, actorId: actor.id },
      );
      return { receipt, payment, invoice: operationsStore().getInvoice(invoiceId, agencyId) };
    }),

  /** Park a provider payment that is not ours to apply. */
  "agency.ops.payments.unmatched.ignore": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        receipt: operationsStore().ignoreExternalPaymentReceipt(
          agencyId,
          stringParam(opts.params.receiptId, "receiptId"),
          optionalString(opts.params.reason),
          { agencyId, actorId: actor.id },
        ),
      };
    }),

  // ── Invoice authoring ──────────────────────────────────────────────────────

  /** The number the next invoice would be given, without consuming it. */
  "agency.ops.invoice.number.next": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const at = optionalNumber(opts.params.issuedAt) ?? Date.now();
      return {
        number: operationsStore().peekDocumentNumber(agencyId, "invoice", at),
        proposalNumber: operationsStore().peekDocumentNumber(agencyId, "proposal", at),
      };
    }),

  /**
   * Create a draft invoice. `issuedAt` may be in the past — the invoice is
   * still a draft, so nothing is recognised until `agency.ops.invoice.issue`.
   */
  /** Reusable agency-level bank / payment options offered in the composer. */
  "agency.ops.payment-accounts.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return { accounts: operationsStore().listPaymentAccounts(agencyId) };
    }),

  /** Create or edit a saved payment option. Owner/admin/member may write it. */
  "agency.ops.payment-accounts.upsert": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const params = opts.params;
      const account = operationsStore().upsertPaymentAccount(
        {
          id: optionalString(params.id),
          label: stringParam(params.label, "label"),
          currency: optionalString(params.currency) ?? null,
          bankName: optionalString(params.bankName) ?? null,
          accountName: optionalString(params.accountName) ?? null,
          accountNumber: optionalString(params.accountNumber) ?? null,
          iban: optionalString(params.iban) ?? null,
          swift: optionalString(params.swift) ?? null,
          routingNumber: optionalString(params.routingNumber) ?? null,
          instructions: optionalString(params.instructions) ?? null,
          isDefault: params.isDefault === true,
        },
        { agencyId, actorId: actor.id },
      );
      return { account };
    }),

  /** Delete a saved payment option, detaching it from any invoice that used it. */
  "agency.ops.payment-accounts.delete": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const deleted = operationsStore().deletePaymentAccount(
        agencyId,
        stringParam(opts.params.id, "id"),
        { agencyId, actorId: actor.id },
      );
      return { deleted };
    }),

  "agency.ops.invoice.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const detail = operationsStore().createInvoiceDraft(
        {
          clientId: stringParam(opts.params.clientId, "clientId"),
          engagementId: optionalString(opts.params.engagementId),
          proposalId: optionalString(opts.params.proposalId),
          number: optionalString(opts.params.number),
          currency: optionalString(opts.params.currency),
          issuedAt: optionalNumber(opts.params.issuedAt),
          dueAt: optionalNumber(opts.params.dueAt),
          taxCents: optionalCents(opts.params.taxCents, "taxCents"),
          taxLabel: optionalString(opts.params.taxLabel),
          reference: optionalString(opts.params.reference),
          notes: optionalString(opts.params.notes),
          terms: optionalString(opts.params.terms),
          paymentAccountId: optionalString(opts.params.paymentAccountId),
          projectIds: stringListParam(opts.params.projectIds),
          lineItems: lineItemsParam(opts.params.lineItems),
        },
        { agencyId, actorId: actor.id },
      );
      return detail;
    }),

  "agency.ops.invoice.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = operationsStore();
      const detail = store.getInvoiceDetail(
        agencyId,
        stringParam(opts.params.invoiceId, "invoiceId"),
      );
      if (!detail) throw new Error("invoice not found");
      return {
        ...detail,
        client: store.getClient(detail.invoice.clientId, agencyId),
      };
    }),

  /**
   * Edit an invoice. Amounts, line items, currency and client are draft-only;
   * notes, terms, reference and due date stay editable after issue.
   */
  "agency.ops.invoice.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const params = opts.params;
      return operationsStore().updateInvoice(
        stringParam(params.invoiceId, "invoiceId"),
        {
          clientId: optionalString(params.clientId),
          engagementId:
            "engagementId" in params ? (optionalString(params.engagementId) ?? null) : undefined,
          proposalId:
            "proposalId" in params ? (optionalString(params.proposalId) ?? null) : undefined,
          number: optionalString(params.number),
          currency: optionalString(params.currency),
          dueAt: "dueAt" in params ? (optionalNumber(params.dueAt) ?? null) : undefined,
          issuedAt: "issuedAt" in params ? (optionalNumber(params.issuedAt) ?? null) : undefined,
          taxCents: optionalCents(params.taxCents, "taxCents"),
          taxLabel: "taxLabel" in params ? (optionalString(params.taxLabel) ?? null) : undefined,
          reference: "reference" in params ? (optionalString(params.reference) ?? null) : undefined,
          notes: "notes" in params ? (optionalString(params.notes) ?? null) : undefined,
          terms: "terms" in params ? (optionalString(params.terms) ?? null) : undefined,
          paymentAccountId:
            "paymentAccountId" in params
              ? (optionalString(params.paymentAccountId) ?? null)
              : undefined,
          lineItems: params.lineItems === undefined ? undefined : lineItemsParam(params.lineItems),
          projectIds:
            params.projectIds === undefined ? undefined : stringListParam(params.projectIds),
        },
        { agencyId, actorId: actor.id },
      );
    }),

  "agency.ops.invoice.lineItem.add": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const [item] = lineItemsParam([opts.params.lineItem ?? opts.params], "lineItem");
      return operationsStore().addInvoiceLineItem(
        stringParam(opts.params.invoiceId, "invoiceId"),
        item,
        { agencyId, actorId: actor.id },
      );
    }),

  "agency.ops.invoice.lineItem.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return operationsStore().updateInvoiceLineItem(
        stringParam(opts.params.invoiceId, "invoiceId"),
        stringParam(opts.params.lineItemId, "lineItemId"),
        {
          description: optionalString(opts.params.description),
          quantity: optionalNumber(opts.params.quantity),
          unitPriceCents: optionalCents(opts.params.unitPriceCents, "unitPriceCents"),
          cadence: optionalString(opts.params.cadence) as InvoiceLineItemInput["cadence"],
        },
        { agencyId, actorId: actor.id },
      );
    }),

  "agency.ops.invoice.lineItem.remove": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return operationsStore().removeInvoiceLineItem(
        stringParam(opts.params.invoiceId, "invoiceId"),
        stringParam(opts.params.lineItemId, "lineItemId"),
        { agencyId, actorId: actor.id },
      );
    }),

  "agency.ops.invoice.lineItems.reorder": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return operationsStore().reorderInvoiceLineItems(
        stringParam(opts.params.invoiceId, "invoiceId"),
        stringListParam(opts.params.lineItemIds),
        { agencyId, actorId: actor.id },
      );
    }),

  "agency.ops.invoice.projects.set": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const projectLinks = operationsStore().setInvoiceProjectLinks(
        invoiceId,
        projectLinksParam(opts.params.projectIds) ?? [],
        { agencyId, actorId: actor.id },
      );
      return { projectLinks };
    }),

  /**
   * Issue an invoice and recognise the revenue. `issuedAt` in the past is the
   * backdating hook: the revenue entry is recognised on that date, so the
   * invoice lands in its own historical period rather than in this month.
   */
  "agency.ops.invoice.issue": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      operationsStore().issueInvoice(
        invoiceId,
        { agencyId, actorId: actor.id },
        {
          issuedAt: optionalNumber(opts.params.issuedAt),
          dueAt: optionalNumber(opts.params.dueAt),
        },
      );
      syncCanonicalAgencyRevenue(agencyId);
      return operationsStore().getInvoiceDetail(agencyId, invoiceId)!;
    }),

  /** Void an invoice and un-recognise its revenue. Refused once paid. */
  "agency.ops.invoice.void": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const invoice = operationsStore().voidInvoice(
        stringParam(opts.params.invoiceId, "invoiceId"),
        { agencyId, actorId: actor.id },
        optionalString(opts.params.reason),
      );
      syncCanonicalAgencyRevenue(agencyId);
      return { invoice };
    }),

  "agency.ops.invoice.payments.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        payments: operationsStore().listInvoicePayments(
          agencyId,
          optionalString(opts.params.invoiceId),
        ),
      };
    }),

  // ── Backlogging: invoices and payments that already happened ───────────────

  /**
   * Record one historical invoice: created, issued at `issuedAt` and paid at
   * each payment's own `paidAt`, in a single transaction. Every date the
   * revenue reports read is the historical one, so nothing shows up as having
   * been transacted today.
   */
  "agency.ops.invoice.backlog.record": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const result = operationsStore().recordHistoricalInvoice(backlogRowParam(opts.params), {
        agencyId,
        actorId: actor.id,
      });
      syncCanonicalAgencyRevenue(agencyId);
      return result;
    }),

  /**
   * Bulk backlog import. All-or-nothing: a failing row aborts the batch with
   * its index, because a half-imported revenue history is worse than none.
   */
  "agency.ops.invoice.backlog.import": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const rows = opts.params.rows;
      if (!Array.isArray(rows) || rows.length === 0)
        throw new Error("rows must be a non-empty array");
      if (rows.length > 1000) throw new Error("import is limited to 1000 rows per call");
      const result = operationsStore().importHistoricalInvoices(
        rows.map((row) => backlogRowParam((row ?? {}) as Record<string, unknown>)),
        { agencyId, actorId: actor.id },
      );
      syncCanonicalAgencyRevenue(agencyId);
      return {
        imported: result.imported.length,
        totalCents: result.totalCents,
        collectedCents: result.collectedCents,
        invoices: result.imported.map((entry) => entry.invoice),
      };
    }),

  // ── Client-facing documents ────────────────────────────────────────────────

  /**
   * In-app invoice preview. Returns the *same* markup the PDF is built from
   * (`fragment: true` wraps it in a `<style>` block instead of a full page), so
   * what the owner approves on screen is byte-for-byte what the client gets.
   */
  "agency.ops.invoice.document.preview": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const theme = optionalString(opts.params.theme);
      const previewInvoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const { model } = invoiceDocumentModelFor(agencyId, previewInvoiceId, {
        theme,
        asOf: optionalNumber(opts.params.asOf),
        // Preview must show the link the PDF will carry, or the operator
        // approves a document that differs from what the client receives.
        paymentLink: resolveDocumentPaymentLink(agencyId, previewInvoiceId, opts.params),
      });
      return {
        html: renderInvoiceDocumentHtml(model, { theme, fragment: true }),
        summaryText: invoiceSummaryText(model),
        status: effectiveInvoiceStatus(model),
        balanceCents: model.totals.totalCents - model.amountPaidCents,
        warnings: checkTotalsConsistency(model.totals, model.lineItems),
      };
    }),

  /**
   * Enqueue the branded invoice PDF through the normal report worker. The model
   * travels in `config.document` as plain JSON — the worker never opens
   * `agency.db`.
   */
  "agency.ops.invoice.document.render": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const theme = optionalString(opts.params.theme) ?? DEFAULT_DOCUMENT_THEME;
      const invoiceId = stringParam(opts.params.invoiceId, "invoiceId");
      const { model, clientId, projectIds } = invoiceDocumentModelFor(agencyId, invoiceId, {
        theme,
        asOf: optionalNumber(opts.params.asOf),
        reference: optionalString(opts.params.reference),
        notes: optionalString(opts.params.notes),
        paymentTerms: optionalString(opts.params.paymentTerms),
        paymentLink: resolveDocumentPaymentLink(agencyId, invoiceId, opts.params),
      });
      const record = enqueueReport({
        kind: INVOICE_REPORT_KIND,
        title: `Invoice ${model.number} — ${model.client.name}`,
        theme,
        trigger: "manual",
        sinks: sinksParam(opts.params.sinks) as never,
        sourceRecordId: model.id,
        config: { document: model, agencyId, clientId },
      });
      setReportAssociations(record.id, { projectId: projectIds[0] ?? null });
      return { reportId: record.id, status: record.status };
    }),

  "agency.ops.proposal.document.preview": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const theme = optionalString(opts.params.theme);
      const { model } = proposalDocumentModelFor(
        agencyId,
        stringParam(opts.params.proposalId, "proposalId"),
        {
          theme,
          asOf: optionalNumber(opts.params.asOf),
          number: optionalString(opts.params.number),
          summary: optionalString(opts.params.summary),
          sections: sectionsParam(opts.params.sections),
          acceptanceTerms:
            opts.params.acceptanceTerms === undefined
              ? undefined
              : stringListParam(opts.params.acceptanceTerms),
        },
      );
      return {
        html: renderProposalDocumentHtml(model, { theme, fragment: true }),
        summaryText: proposalSummaryText(model),
        status: effectiveProposalStatus(model),
        // A proposal has nothing paid against it; the balance is the whole
        // total, reported for shape-parity with the invoice preview.
        balanceCents: model.totals.totalCents,
        warnings: checkTotalsConsistency(model.totals, model.lineItems),
      };
    }),

  "agency.ops.proposal.document.render": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const theme = optionalString(opts.params.theme) ?? DEFAULT_DOCUMENT_THEME;
      const { model, clientId } = proposalDocumentModelFor(
        agencyId,
        stringParam(opts.params.proposalId, "proposalId"),
        {
          theme,
          asOf: optionalNumber(opts.params.asOf),
          number: optionalString(opts.params.number),
          summary: optionalString(opts.params.summary),
          sections: sectionsParam(opts.params.sections),
          acceptanceTerms:
            opts.params.acceptanceTerms === undefined
              ? undefined
              : stringListParam(opts.params.acceptanceTerms),
          notes: optionalString(opts.params.notes),
        },
      );
      const record = enqueueReport({
        kind: PROPOSAL_REPORT_KIND,
        title: `Proposal ${model.number} — ${model.client.name}`,
        theme,
        trigger: "manual",
        sinks: sinksParam(opts.params.sinks) as never,
        sourceRecordId: model.id,
        config: { document: model, agencyId, clientId },
      });
      return { reportId: record.id, status: record.status };
    }),

  // ── Proposals ──────────────────────────────────────────────────────────────

  /**
   * Create a proposal. Pass `clientId` and an opportunity is opened for you at
   * the `proposal` stage, sized to the proposal — which is how the value
   * reaches `agency.ops.revenue.summary`'s pipeline figures.
   */
  "agency.ops.proposal.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        proposal: operationsStore().createProposal(
          {
            clientId: optionalString(opts.params.clientId),
            opportunityId: optionalString(opts.params.opportunityId),
            title: stringParam(opts.params.title, "title"),
            scope: stringParam(opts.params.scope, "scope"),
            summary: optionalString(opts.params.summary),
            number: optionalString(opts.params.number),
            currency: optionalString(opts.params.currency),
            validUntil: optionalNumber(opts.params.validUntil),
            createdAt: optionalNumber(opts.params.createdAt),
            taxCents: optionalCents(opts.params.taxCents, "taxCents"),
            sections: sectionsParam(opts.params.sections),
            acceptanceTerms: stringListParam(opts.params.acceptanceTerms),
            lineItems: proposalLineItemsParam(opts.params.lineItems),
          },
          { agencyId, actorId: actor.id },
        ),
      };
    }),

  "agency.ops.proposal.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const proposal = operationsStore().getProposal(
        stringParam(opts.params.proposalId, "proposalId"),
        agencyId,
      );
      if (!proposal) throw new Error("proposal not found");
      return { proposal };
    }),

  "agency.ops.proposal.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = operationsStore();
      const clients = new Map(
        store.listClients(agencyId).map((client) => [client.id, client.name]),
      );
      const status = optionalString(opts.params.status);
      return {
        proposals: store
          .listProposals(agencyId, {
            status: status ? proposalStatusParam(status) : undefined,
            clientId: optionalString(opts.params.clientId),
          })
          .map((proposal) => ({
            ...proposal,
            clientName: proposal.clientId
              ? (clients.get(proposal.clientId) ?? "Unknown client")
              : null,
          })),
      };
    }),

  "agency.ops.proposal.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const params = opts.params;
      return {
        proposal: operationsStore().updateProposal(
          stringParam(params.proposalId, "proposalId"),
          {
            title: optionalString(params.title),
            scope: optionalString(params.scope),
            summary: "summary" in params ? (optionalString(params.summary) ?? null) : undefined,
            number: optionalString(params.number),
            currency: optionalString(params.currency),
            validUntil:
              "validUntil" in params ? (optionalNumber(params.validUntil) ?? null) : undefined,
            taxCents: optionalCents(params.taxCents, "taxCents"),
            sections: sectionsParam(params.sections),
            acceptanceTerms:
              params.acceptanceTerms === undefined
                ? undefined
                : stringListParam(params.acceptanceTerms),
            lineItems:
              params.lineItems === undefined ? undefined : proposalLineItemsParam(params.lineItems),
          },
          { agencyId, actorId: actor.id },
        ),
      };
    }),

  /**
   * Move a proposal to any legal status, walking the intermediate states the
   * machine requires. Nothing is skipped — the caller just doesn't have to
   * spell out `draft → internal_review → sent` for a deal agreed by phone.
   */
  "agency.ops.proposal.status.set": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const status = proposalStatusParam(opts.params.status);
      const proposalId = stringParam(opts.params.proposalId, "proposalId");
      const store = operationsStore();
      const proposal =
        status === "accepted"
          ? store.acceptProposal(
              proposalId,
              { agencyId, actorId: actor.id },
              optionalNumber(opts.params.acceptedAt),
            )
          : store.advanceProposalTo(proposalId, status, { agencyId, actorId: actor.id });
      return { proposal, pipeline: store.revenuePipelineSummary(agencyId) };
    }),

  /**
   * Accept a proposal. The opportunity behind it is resized to the agreed total
   * and marked won, which is what moves `revenue.summary.pipeline`.
   * `acceptedAt` may be backdated.
   */
  "agency.ops.proposal.accept": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const store = operationsStore();
      const proposal = store.acceptProposal(
        stringParam(opts.params.proposalId, "proposalId"),
        { agencyId, actorId: actor.id },
        optionalNumber(opts.params.acceptedAt),
      );
      return { proposal, pipeline: store.revenuePipelineSummary(agencyId) };
    }),

  "agency.ops.revenue.summary": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const period = monthWindow();
      const revenue = operationsStore().revenueSummary(
        agencyId,
        numberParam(opts.params.startAt, period.startAt),
        numberParam(opts.params.endAt, period.endAt),
      );
      // Roll per-project MRR (set on the /projects header popover) into the
      // headline MRR/ARR the Agency Operations view reads. See
      // kanbanProjectsMrrCents().
      const projectMrrCents = kanbanProjectsMrrCents();
      revenue.mrrCents += projectMrrCents;
      revenue.arrCents = revenue.mrrCents * 12;
      const canonical = syncCanonicalAgencyRevenue(agencyId);
      const startAt = numberParam(opts.params.startAt, period.startAt);
      const endAt = numberParam(opts.params.endAt, period.endAt);
      return {
        revenue,
        unified: {
          summary: hubRevenueSummary(canonical.db, { from: startAt, to: endAt }),
          arAging: hubRevenueArAging(canonical.db),
          merge: canonical.merge,
        },
        entries: operationsStore().listRevenueEntries(agencyId, {
          startAt,
          endAt,
          limit: numberParam(opts.params.limit, 250),
        }),
        clientProfiles: operationsStore().listClientRevenueProfiles(agencyId),
      };
    }),

  "agency.ops.members.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return { members: operationsStore().listAgencyMembers(agencyId) };
    }),

  "agency.ops.member.role.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const role = stringParam(opts.params.role, "role") as AgencyRole;
      if (!["admin", "member", "viewer"].includes(role)) throw new Error("invalid member role");
      return {
        membership: operationsStore().setAgencyMemberRole(
          agencyId,
          stringParam(opts.params.userId, "userId"),
          role,
          actor.id,
        ),
      };
    }),

  "agency.ops.member.remove": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      operationsStore().removeAgencyMember(
        agencyId,
        stringParam(opts.params.userId, "userId"),
        actor.id,
      );
      return { removed: true };
    }),

  "agency.ops.audit.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const operating = operationsStore().listAgencyAuditEvents(agencyId, {
        limit: numberParam(opts.params.limit, 100),
        beforeId: typeof opts.params.beforeId === "number" ? opts.params.beforeId : undefined,
        entityType: optionalString(opts.params.entityType),
        actorId: optionalString(opts.params.actorId),
      });
      const workforce = workforceStore().listAuditEntries(
        agencyId,
        numberParam(opts.params.limit, 100),
      );
      const events = [...operating, ...workforce]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, Math.max(1, Math.min(500, numberParam(opts.params.limit, 100))));
      return { events, nextBeforeId: operating.at(-1)?.id ?? null };
    }),

  "agency.ops.employee.detail": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const workerId = stringParam(opts.params.workerId, "workerId");
      const workforce = workforceStore();
      const employee = workforce.getWorker(agencyId, workerId);
      if (!employee) throw new Error("employee not found");
      return {
        employee,
        capacity: workforce.getWorkerCapacity(agencyId, workerId),
        assignments: workforce
          .listAssignments(agencyId)
          .filter((assignment) =>
            assignment.members.some((member) => member.workerId === workerId),
          ),
        performance:
          workforce.getPerformanceScorecards(agencyId).find((item) => item.workerId === workerId) ??
          null,
      };
    }),

  "agency.ops.assignments.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        assignments: workforceStore().listAssignments(
          agencyId,
          optionalString(opts.params.status) as AssignmentStatus | undefined,
        ),
      };
    }),

  "agency.ops.assignment.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const requiredSkills = Array.isArray(opts.params.requiredSkills)
        ? (opts.params.requiredSkills as unknown as SkillRequirement[])
        : [];
      const members = Array.isArray(opts.params.members)
        ? (opts.params.members as unknown as AssignmentMember[])
        : [];
      return {
        assignment: workforceStore().createAssignment(
          {
            agencyId,
            title: stringParam(opts.params.title, "title"),
            description: optionalString(opts.params.description),
            projectId: optionalString(opts.params.projectId) ?? null,
            taskId: optionalString(opts.params.taskId) ?? null,
            estimatedHours: numberParam(opts.params.estimatedHours),
            priority: numberParam(opts.params.priority, 3),
            dueAt: typeof opts.params.dueAt === "number" ? opts.params.dueAt : null,
            requiredSkills,
            requiredCapabilities: Array.isArray(opts.params.requiredCapabilities)
              ? opts.params.requiredCapabilities.filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
            members,
            createdBy: actor.id,
          },
          actor.id,
        ),
      };
    }),

  "agency.ops.assignment.suitability": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const workforce = workforceStore();
      const request: SuitabilityRequest = {
        requiredSkills: Array.isArray(opts.params.requiredSkills)
          ? (opts.params.requiredSkills as unknown as SkillRequirement[])
          : [],
        requiredCapabilities: Array.isArray(opts.params.requiredCapabilities)
          ? opts.params.requiredCapabilities.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        estimatedHours: numberParam(opts.params.estimatedHours),
        maximumHourlyCost:
          typeof opts.params.maximumHourlyCost === "number"
            ? opts.params.maximumHourlyCost
            : undefined,
        preferredType:
          opts.params.preferredType === "human" || opts.params.preferredType === "ai"
            ? opts.params.preferredType
            : undefined,
      };
      const workers = workforce.listWorkers(agencyId, { status: "active" });
      const capacities = new Map(
        workforce.getWorkloadSummary(agencyId).map((capacity) => [capacity.workerId, capacity]),
      );
      return {
        recommendations: workers
          .map((worker) => scoreWorkerSuitability(worker, capacities.get(worker.id)!, request))
          .sort((a, b) => b.score - a.score),
      };
    }),

  "agency.ops.assignment.hybrid-plan": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const workforce = workforceStore();
      const request = {
        requiredSkills: Array.isArray(opts.params.requiredSkills)
          ? (opts.params.requiredSkills as unknown as SkillRequirement[])
          : [],
        requiredCapabilities: Array.isArray(opts.params.requiredCapabilities)
          ? opts.params.requiredCapabilities.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        estimatedHours: numberParam(opts.params.estimatedHours),
        maximumTeamSize: numberParam(opts.params.maximumTeamSize, 4),
        maximumHourlyCost:
          typeof opts.params.maximumHourlyCost === "number"
            ? opts.params.maximumHourlyCost
            : undefined,
        requireHuman: opts.params.requireHuman !== false,
        requireAi: opts.params.requireAi !== false,
      } as HybridTeamRequest;
      const workers = workforce.listWorkers(agencyId, { status: "active" });
      const capacities = new Map(
        workforce.getWorkloadSummary(agencyId).map((capacity) => [capacity.workerId, capacity]),
      );
      return { plan: planHybridTeam(workers, capacities, request) };
    }),

  "agency.ops.employee.inbox.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        workItems: workforceOperatingStore().listWorkItems(agencyId, {
          workerId: optionalString(opts.params.workerId),
          status: optionalString(opts.params.status) as WorkItemStatus | undefined,
          limit: numberParam(opts.params.limit, 100),
        }),
      };
    }),

  "agency.ops.employee.work-item.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        workItem: workforceOperatingStore().enqueueWorkItem(agencyId, {
          workerId: stringParam(opts.params.workerId, "workerId"),
          managerWorkerId: optionalString(opts.params.managerWorkerId) ?? null,
          title: stringParam(opts.params.title, "title"),
          instructions: optionalString(opts.params.instructions),
          priority: (optionalString(opts.params.priority) ?? "normal") as WorkItemPriority,
          scheduledFor:
            typeof opts.params.scheduledFor === "number" ? opts.params.scheduledFor : undefined,
          dueAt: typeof opts.params.dueAt === "number" ? opts.params.dueAt : null,
          idempotencyKey: optionalString(opts.params.idempotencyKey) ?? null,
          context:
            opts.params.context && typeof opts.params.context === "object"
              ? (opts.params.context as Record<string, unknown>)
              : { createdBy: actor.id },
        }),
      };
    }),

  "agency.ops.employee.work-item.transition": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        workItem: workforceOperatingStore().transitionWorkItem(
          agencyId,
          stringParam(opts.params.workItemId, "workItemId"),
          stringParam(opts.params.status, "status") as WorkItemStatus,
          {
            waitingReason: optionalString(opts.params.waitingReason),
            reviewNote: optionalString(opts.params.reviewNote),
          },
        ),
      };
    }),

  /**
   * Board feed: every work item currently STAGED for autonomous execution
   * (status `accepted`), plus why each will or will not run and where a
   * successful run would land it. Read-only — never spawns anything.
   */
  "agency.ops.employee.work-item.execution.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        stage: EXECUTION_STAGE,
        executorEnabled: workItemExecutorConfig().enabled,
        items: listExecutionEligibleWorkItems(workItemExecutionViewDeps(), agencyId, {
          workerId: optionalString(opts.params.workerId),
          limit: numberParam(opts.params.limit, 100),
        }),
      };
    }),

  /**
   * Execution readiness for a single card, including its last run recorded in
   * job memory. Read-only.
   */
  "agency.ops.employee.work-item.execution.status": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const workItemId = stringParam(opts.params.workItemId, "workItemId");
      const item = workforceOperatingStore().getWorkItem(agencyId, workItemId);
      if (!item) throw new Error("work item not found");
      return {
        stage: EXECUTION_STAGE,
        execution: describeWorkItemExecution(workItemExecutionViewDeps(), agencyId, item),
      };
    }),

  "agency.ops.employee.schedules.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        schedules: workforceOperatingStore().listSchedules(
          agencyId,
          optionalString(opts.params.workerId),
        ),
      };
    }),

  "agency.ops.employee.schedule.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        schedule: workforceOperatingStore().createSchedule(agencyId, {
          workerId: stringParam(opts.params.workerId, "workerId"),
          timezone: optionalString(opts.params.timezone) ?? "UTC",
          weekdays: Array.isArray(opts.params.weekdays)
            ? opts.params.weekdays.filter((item): item is number => typeof item === "number")
            : [1, 2, 3, 4, 5],
          shiftStart: optionalString(opts.params.shiftStart) ?? "09:00",
          shiftEnd: optionalString(opts.params.shiftEnd) ?? "17:00",
          effectiveFrom: stringParam(opts.params.effectiveFrom, "effectiveFrom"),
          effectiveTo: optionalString(opts.params.effectiveTo) ?? null,
          enabled: opts.params.enabled !== false,
        }),
      };
    }),

  "agency.ops.employee.responsibilities.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        responsibilities: workforceOperatingStore().listResponsibilities(
          agencyId,
          optionalString(opts.params.workerId),
        ),
      };
    }),

  "agency.ops.employee.responsibility.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        responsibility: workforceOperatingStore().createResponsibility(agencyId, {
          workerId: stringParam(opts.params.workerId, "workerId"),
          managerWorkerId: optionalString(opts.params.managerWorkerId) ?? null,
          title: stringParam(opts.params.title, "title"),
          instructions: optionalString(opts.params.instructions) ?? "",
          cadence: stringParam(opts.params.cadence, "cadence") as "daily" | "weekly" | "monthly",
          interval: numberParam(opts.params.interval, 1),
          weekday: typeof opts.params.weekday === "number" ? opts.params.weekday : null,
          monthDay: typeof opts.params.monthDay === "number" ? opts.params.monthDay : null,
          runAt: optionalString(opts.params.runAt) ?? "09:00",
          slaMinutes: numberParam(opts.params.slaMinutes, 1_440),
          priority: (optionalString(opts.params.priority) ?? "normal") as WorkItemPriority,
          enabled: opts.params.enabled !== false,
          nextRunAt: numberParam(opts.params.nextRunAt),
          context:
            opts.params.context && typeof opts.params.context === "object"
              ? (opts.params.context as Record<string, unknown>)
              : {},
        }),
      };
    }),

  "agency.ops.employee.reviews.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        reviewCycles: workforceOperatingStore().listReviewCycles(
          agencyId,
          optionalString(opts.params.workerId),
        ),
      };
    }),

  "agency.ops.employee.review-cycle.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        reviewCycle: workforceOperatingStore().createReviewCycle(agencyId, {
          workerId: stringParam(opts.params.workerId, "workerId"),
          managerWorkerId: stringParam(opts.params.managerWorkerId, "managerWorkerId"),
          cadenceDays: numberParam(opts.params.cadenceDays, 7),
          nextReviewAt: numberParam(opts.params.nextReviewAt),
          agenda: Array.isArray(opts.params.agenda)
            ? opts.params.agenda.filter((item): item is string => typeof item === "string")
            : [],
        }),
      };
    }),

  "agency.ops.employee.review-cycle.complete": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        reviewCycle: workforceOperatingStore().completeReviewCycle(
          agencyId,
          stringParam(opts.params.reviewCycleId, "reviewCycleId"),
          stringParam(opts.params.outcome, "outcome"),
        ),
      };
    }),

  "agency.ops.employee.memory.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        memory: workforceOperatingStore().listJobMemory(
          agencyId,
          stringParam(opts.params.workerId, "workerId"),
          optionalString(opts.params.namespace),
        ),
      };
    }),

  "agency.ops.employee.memory.upsert": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        memory: workforceOperatingStore().upsertJobMemory(agencyId, {
          workerId: stringParam(opts.params.workerId, "workerId"),
          workItemId: optionalString(opts.params.workItemId) ?? null,
          namespace: stringParam(opts.params.namespace, "namespace"),
          key: stringParam(opts.params.key, "key"),
          value: opts.params.value,
          source: optionalString(opts.params.source) ?? "employee",
          expiresAt: typeof opts.params.expiresAt === "number" ? opts.params.expiresAt : null,
        }),
      };
    }),

  "agency.ops.employee.loop.tick": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const result = workforceOperatingStore().tick(agencyId);

      /*
       * Generation alone is only half a pass. Staged cards are executed by the
       * background scheduler, so a "run now" that only ticked left an operator
       * watching authorised work sit in Staged for up to the full loop interval
       * with no feedback — it looked like the loop was broken. Run the
       * execution half for this agency too.
       *
       * Safety is unchanged: createAgencyOperatingLoopDeps does not even build
       * an executor unless `cron.agencyOperatingLoop.executeWorkItems` is true,
       * so with the flag off `executeWorkItems` is undefined and this is inert.
       * Only cards a human already moved to the staged column are eligible.
       */
      const { createAgencyOperatingLoopDeps } =
        await import("../../agency-operations/operating-loop.js");
      const stateDir = resolveStateDir();
      const deps = createAgencyOperatingLoopDeps(stateDir, undefined, {
        execution: loadConfig()?.cron?.agencyOperatingLoop ?? null,
        workspaceRoot: stateDir,
        broadcast: (event, payload) => opts.context.broadcast(event, payload, { dropIfSlow: true }),
      });
      const execution = deps.executeWorkItems ? await deps.executeWorkItems(agencyId) : null;
      /*
       * Third half of a pass: anything an employee escalated during execution
       * has to actually reach the human, and any digest whose window closed has
       * to go out. Idempotent by construction — delivery candidates are chosen
       * on `delivered_at IS NULL`, so running this on every tick can never
       * re-send an escalation the owner has already read.
       */
      const escalations = await escalationService(opts).processQueue(agencyId);
      const digest = await escalationService(opts).flushDigests(agencyId);
      return { result, execution, escalations, digest };
    }),

  // ── First-class SOPs ──────────────────────────────────────────────────────
  // Procedures live in `wf_sops`; attaching a schedule creates a REAL cron job
  // plus the recurring responsibility the operating loop ticks. Everything
  // generated lands in `queued` (Backlog) — `accepted` remains the human
  // authorisation gate for autonomous execution.

  "agency.ops.sops.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = workforceSopStore();
      const sops = store.listSops(agencyId, {
        ownerWorkerId: optionalString(opts.params.ownerWorkerId),
        status: optionalString(opts.params.status) as SopStatus | undefined,
        category: optionalString(opts.params.category),
      });
      return {
        seedVersion: SOP_SEED_VERSION,
        sops: sops.map((sop) => sopPayload(sop)),
      };
    }),

  /**
   * Idempotently provision the starter SOPs for the six seeded roles. A repeat
   * call with no intervening changes performs no writes at all, and never
   * rewrites an SOP an operator has taken over.
   *
   * Deliberately does NOT attach schedules: that creates cron jobs and
   * generates work, so it stays an explicit operator action.
   */
  "agency.ops.sops.seed": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      seedAgencyAiWorkforce(workforceStore(), agencyId, actor.id);
      const result = seedAgencySops(workforceSopStore(), agencyId, workerIdsByRoleId(agencyId));
      // Only audit a real change — a no-op re-seed writes nothing anywhere.
      if (result.created || result.adopted) {
        workforceStore().recordAudit(
          agencyId,
          actor.id,
          "sop.seeded",
          "sop",
          `seed:v${SOP_SEED_VERSION}`,
          null,
          result,
        );
      }
      return { seedVersion: SOP_SEED_VERSION, ...result };
    }),

  // ── Communication profile ──────────────────────────────────────────────────

  /**
   * The employee's structured communication profile. Rows that predate the
   * feature are migrated from the legacy `communicationCadence` string on the
   * fly — read-only, so merely opening the UI never writes to agency.db.
   */
  "agency.ops.employee.communication.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const workforce = workforceStore();
      const worker = workforce.getWorker(agencyId, employeeId);
      if (!worker) throw new Error("employee not found");
      const profile = resolveCommunicationProfile(worker);
      return {
        employeeId,
        profile,
        /** True while the profile is still derived rather than stored. */
        migratedFromLegacy: worker.communicationProfile === null,
        summary: summarizeCommunicationProfile(profile),
        bindings: workforce.listChannelBindings(agencyId, { workerId: employeeId }),
        options: communicationOptions(),
      };
    }),

  /**
   * Merge a patch into the employee's communication profile. Partial by
   * design: send only the fields the operator touched. Unknown channel ids in
   * `profile.channelOverrides` are dropped, numbers clamped.
   */
  "agency.ops.employee.communication.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const patch =
        opts.params.profile && typeof opts.params.profile === "object"
          ? (opts.params.profile as Record<string, unknown>)
          : {};
      const result = workforceStore().setCommunicationProfile(
        agencyId,
        employeeId,
        patch,
        actor.id,
      );
      if (!result) throw new Error("employee not found");
      return {
        employeeId,
        profile: result.profile,
        // False on a genuine no-op: nothing was written and nothing audited.
        changed: result.changed,
        summary: summarizeCommunicationProfile(result.profile),
      };
    }),

  /**
   * What would this employee do with a message arriving right now? Resolves
   * the per-channel override, then applies the worker's real shifts from
   * `wf_employee_schedules`. Pure preview — writes nothing.
   */
  "agency.ops.employee.communication.preview": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const worker = workforceStore().getWorker(agencyId, employeeId);
      if (!worker) throw new Error("employee not found");
      const channelId = opts.params.channelId ? parseChannelId(opts.params.channelId) : null;
      const profile = resolveCommunicationProfile(worker);
      const schedules = workforceOperatingStore().listSchedules(agencyId, employeeId);
      const now = typeof opts.params.now === "number" ? opts.params.now : Date.now();
      return {
        employeeId,
        channelId,
        plan: planResponse({
          profile,
          channelId,
          schedules,
          now,
          urgent: opts.params.urgent === true,
        }),
        effective: channelId ? effectiveChannelProfile(profile, channelId) : null,
        schedules,
      };
    }),

  // ── Escalation protocol ────────────────────────────────────────────────────
  // Exception-based oversight. Employees run autonomously and reach the human
  // only when something genuinely needs them; the human's reply is correlated
  // back to the escalation, unblocks the work item, and lands in job memory.

  /**
   * The escalation board. Filters are all optional; `openOnly` is the useful
   * default view (anything not resolved, cancelled or suppressed).
   */
  "agency.ops.escalations.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = escalationStore();
      const escalations = store.list(agencyId, {
        ...(optionalString(opts.params.employeeId)
          ? { workerId: optionalString(opts.params.employeeId)! }
          : {}),
        ...(optionalString(opts.params.workItemId)
          ? { workItemId: optionalString(opts.params.workItemId)! }
          : {}),
        ...(opts.params.kind ? { kind: parseEscalationKind(opts.params.kind) } : {}),
        ...(opts.params.status ? { status: parseEscalationStatus(opts.params.status) } : {}),
        ...(opts.params.openOnly === true ? { openOnly: true } : {}),
        ...(typeof opts.params.since === "number" ? { since: opts.params.since } : {}),
        limit: numberParam(opts.params.limit, 100),
        offset: numberParam(opts.params.offset, 0),
      });
      return {
        escalations,
        options: escalationOptions(),
        counts: {
          awaitingApproval: escalations.filter((e) => e.status === "awaiting_approval").length,
          open: escalations.filter((e) => e.status === "delivered" && !e.answeredAt).length,
          failed: escalations.filter((e) => e.status === "failed").length,
        },
      };
    }),

  /** One escalation plus every delivery attempt made for it. */
  "agency.ops.escalation.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const escalationId = stringParam(opts.params.escalationId, "escalationId");
      const store = escalationStore();
      const escalation = store.get(agencyId, escalationId);
      if (!escalation) throw new Error("escalation not found");
      return {
        escalation,
        deliveries: store.listDeliveries(agencyId, escalationId),
        workItem: escalation.workItemId
          ? workforceOperatingStore().getWorkItem(agencyId, escalation.workItemId)
          : null,
        policy: store.getPolicy(agencyId, escalation.workerId),
      };
    }),

  /**
   * Raise an escalation on an employee's behalf. Persists only — the message
   * goes out on the next `agency.ops.escalations.dispatch` (or loop tick), so
   * a client never sees anything a human has not approved.
   */
  "agency.ops.escalation.raise": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const service = escalationService(opts);
      const result = service.raise(agencyId, {
        workerId: stringParam(opts.params.employeeId, "employeeId"),
        kind: parseEscalationKind(opts.params.kind),
        title: stringParam(opts.params.title, "title"),
        workItemId: optionalString(opts.params.workItemId) ?? null,
        urgency: parseEscalationUrgency(opts.params.urgency),
        summary: optionalString(opts.params.summary) ?? "",
        question: optionalString(opts.params.question) ?? null,
        options: stringListParam(opts.params.options),
        reference: optionalString(opts.params.reference) ?? null,
        recipientKind: optionalString(opts.params.recipientKind) ?? null,
        recipientLabel: optionalString(opts.params.recipientLabel) ?? null,
        channelId: optionalString(opts.params.channelId) ?? null,
        target: optionalString(opts.params.target) ?? null,
        ...(typeof opts.params.requiresApproval === "boolean"
          ? { requiresApproval: opts.params.requiresApproval }
          : {}),
        approvalChannelId: optionalString(opts.params.approvalChannelId) ?? null,
        approvalTarget: optionalString(opts.params.approvalTarget) ?? null,
        draftMessage: optionalString(opts.params.draftMessage) ?? null,
        dedupeKey: optionalString(opts.params.dedupeKey) ?? null,
        context:
          opts.params.context && typeof opts.params.context === "object"
            ? (opts.params.context as Record<string, unknown>)
            : {},
      });
      if (result.created) {
        workforceStore().recordAudit(
          agencyId,
          actor.id,
          "escalation.raised",
          "escalation",
          result.escalation.id,
          null,
          { kind: result.escalation.kind, decision: result.decision },
        );
      }
      return result;
    }),

  /**
   * The human's answer. Resolves the escalation, writes the answer into job
   * memory under `escalation/answer:<code>` (which the executor already reads
   * when composing the next prompt), and lifts the work item out of `waiting`.
   */
  "agency.ops.escalation.answer": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return escalationService(opts).answer(
        agencyId,
        stringParam(opts.params.escalationId, "escalationId"),
        {
          answer: stringParam(opts.params.answer, "answer"),
          actorId: actor.id,
          ...(typeof opts.params.resume === "boolean" ? { resume: opts.params.resume } : {}),
          note: optionalString(opts.params.note) ?? null,
        },
      );
    }),

  /**
   * Approve a drafted outbound message. `editedMessage` replaces the wording —
   * the employee's original stays on the record. Approval only re-arms
   * delivery; the send happens on the next dispatch pass.
   */
  "agency.ops.escalation.approve": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const escalation = escalationService(opts).approve(
        agencyId,
        stringParam(opts.params.escalationId, "escalationId"),
        { actorId: actor.id, editedMessage: optionalString(opts.params.editedMessage) ?? null },
      );
      return { escalation };
    }),

  "agency.ops.escalation.reject": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const escalation = escalationService(opts).reject(
        agencyId,
        stringParam(opts.params.escalationId, "escalationId"),
        { actorId: actor.id, reason: optionalString(opts.params.reason) ?? null },
      );
      return { escalation };
    }),

  /** Close an escalation without answering it. */
  "agency.ops.escalation.resolve": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const escalation = escalationService(opts).resolve(
        agencyId,
        stringParam(opts.params.escalationId, "escalationId"),
        { actorId: actor.id, note: optionalString(opts.params.note) ?? null },
      );
      return { escalation };
    }),

  /** Re-arm a failed or suppressed escalation for the next dispatch pass. */
  "agency.ops.escalation.retry": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      const escalation = escalationService(opts).retry(
        agencyId,
        stringParam(opts.params.escalationId, "escalationId"),
        { resetAttempts: opts.params.resetAttempts === true },
      );
      return { escalation };
    }),

  "agency.ops.escalation.cancel": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const escalation = escalationService(opts).cancel(
        agencyId,
        stringParam(opts.params.escalationId, "escalationId"),
        { actorId: actor.id, reason: optionalString(opts.params.reason) ?? null },
      );
      return { escalation };
    }),

  /**
   * Correlate a raw inbound message with an open escalation. Used by the
   * channel observer and available directly for channels (or bridges) that
   * cannot register one.
   */
  "agency.ops.escalation.reply.ingest": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return escalationService(opts).ingestReply({
        agencyId,
        channelId: optionalString(opts.params.channelId) ?? null,
        target: optionalString(opts.params.target) ?? null,
        workerId: optionalString(opts.params.employeeId) ?? null,
        text: stringParam(opts.params.text, "text"),
        actorId: actor.id,
      });
    }),

  /**
   * Run one delivery pass: outstanding approval requests, then everything due,
   * then any digest whose window has closed. Idempotent — an escalation that
   * already has a `deliveredAt` is invisible to it.
   */
  "agency.ops.escalations.dispatch": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin"]);
      const service = escalationService(opts);
      const queue = await service.processQueue(agencyId, {
        limit: numberParam(opts.params.limit, 25),
      });
      const digest = await service.flushDigests(agencyId);
      return { queue, digest };
    }),

  /**
   * Effective escalation policy. Pass `employeeId` for the per-worker view
   * (the agency default with that worker's overrides merged on top).
   */
  "agency.ops.escalation.policy.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const employeeId = optionalString(opts.params.employeeId) ?? null;
      const store = escalationStore();
      return {
        employeeId,
        policy: store.getPolicy(agencyId, employeeId),
        agencyPolicy: store.getPolicy(agencyId),
        /** Null when this worker has no override of its own. */
        overrides: employeeId ? store.getStoredPolicy(agencyId, employeeId) : null,
        options: escalationOptions(),
      };
    }),

  /**
   * Merge a patch into the escalation policy. Partial by design; a no-op
   * writes nothing and audits nothing.
   */
  "agency.ops.escalation.policy.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const employeeId = optionalString(opts.params.employeeId) ?? null;
      const patch =
        opts.params.policy && typeof opts.params.policy === "object"
          ? (opts.params.policy as Record<string, unknown>)
          : {};
      const result = escalationStore().setPolicy(agencyId, employeeId, patch);
      if (result.changed) {
        workforceStore().recordAudit(
          agencyId,
          actor.id,
          "escalation.policy.updated",
          "escalation_policy",
          employeeId ?? agencyId,
          null,
          result.policy,
        );
      }
      return { employeeId, policy: result.policy, changed: result.changed };
    }),

  // ── Channel bindings (routing only, never credentials) ─────────────────────

  /** The channels this gateway knows about — the only legal `channelId`s. */
  "agency.ops.channels.catalog": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        channels: listChatChannels().map((meta) => ({
          id: meta.id,
          label: meta.label,
          detailLabel: meta.detailLabel,
          blurb: meta.blurb,
          docsPath: meta.docsPath,
        })),
        directions: CHANNEL_BINDING_DIRECTIONS,
      };
    }),

  "agency.ops.employee.channels.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const employeeId = optionalString(opts.params.employeeId);
      const channelId = opts.params.channelId ? parseChannelId(opts.params.channelId) : undefined;
      return {
        bindings: workforceStore().listChannelBindings(agencyId, {
          ...(employeeId ? { workerId: employeeId } : {}),
          ...(channelId ? { channelId } : {}),
          ...(typeof opts.params.enabled === "boolean" ? { enabled: opts.params.enabled } : {}),
        }),
      };
    }),

  /**
   * Bind an employee to a chat channel, or update the binding for the same
   * (employee, channel, target) triple. `channelId` is validated against the
   * channel registry and `config` is rejected outright if it looks like it
   * carries a token or secret — channel credentials live in the gateway
   * configuration, never in the replicated agency database.
   */
  "agency.ops.employee.channel.bind": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const config =
        opts.params.config && typeof opts.params.config === "object"
          ? (opts.params.config as Record<string, unknown>)
          : {};
      const binding = workforceStore().upsertChannelBinding(
        agencyId,
        {
          workerId: employeeId,
          channelId: stringParam(opts.params.channelId, "channelId"),
          target: optionalString(opts.params.target) ?? null,
          handle: optionalString(opts.params.handle) ?? null,
          ...(opts.params.direction !== undefined
            ? { direction: String(opts.params.direction) }
            : {}),
          ...(typeof opts.params.enabled === "boolean" ? { enabled: opts.params.enabled } : {}),
          config,
        },
        actor.id,
      );
      return { binding };
    }),

  "agency.ops.employee.channel.unbind": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const bindingId = stringParam(opts.params.bindingId, "bindingId");
      const removed = workforceStore().removeChannelBinding(agencyId, bindingId, actor.id);
      if (!removed) throw new Error("channel binding not found");
      return { removed: true, bindingId };
    }),

  // ── Execution profile ──────────────────────────────────────────────────────

  "agency.ops.employee.execution.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const worker = workforceStore().getWorker(agencyId, employeeId);
      if (!worker) throw new Error("employee not found");
      const config = workItemExecutorConfig();
      const profile = resolveExecutionProfile(worker);
      return {
        employeeId,
        profile,
        modelBinding: worker.modelBinding,
        autonomyLevel: worker.autonomyLevel,
        approvalThreshold: worker.approvalThreshold,
        capabilities: worker.capabilities,
        /** What a null field in `profile` actually resolves to right now. */
        inherited: {
          fallbackBackend: config.fallbackBackend ?? null,
          defaultBackend: config.defaultBackend,
          timeoutMinutes: config.timeoutMinutes,
          maxConcurrency: config.maxConcurrency,
        },
      };
    }),

  /**
   * Update the employee's runtime knobs, and optionally the plain worker
   * columns that sit beside them (`modelBinding`, autonomy, approval
   * threshold, capability list) so the UI can save one form in one call.
   */
  "agency.ops.employee.execution.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const employeeId = stringParam(opts.params.employeeId, "employeeId");
      const workforce = workforceStore();

      const patch: Parameters<typeof workforce.updateWorker>[2] = {};
      if (opts.params.modelBinding !== undefined) {
        patch.modelBinding = optionalString(opts.params.modelBinding) ?? null;
      }
      if (typeof opts.params.autonomyLevel === "number") {
        const level = Math.trunc(opts.params.autonomyLevel);
        if (level < 0 || level > 3) throw new Error("autonomyLevel must be between 0 and 3");
        patch.autonomyLevel = level as 0 | 1 | 2 | 3;
      }
      if (typeof opts.params.approvalThreshold === "number") {
        if (!Number.isFinite(opts.params.approvalThreshold) || opts.params.approvalThreshold < 0) {
          throw new Error("approvalThreshold must be a non-negative number");
        }
        patch.approvalThreshold = opts.params.approvalThreshold;
      }
      if (opts.params.capabilities !== undefined) {
        patch.capabilities = stringListParam(opts.params.capabilities);
      }
      if (Object.keys(patch).length) {
        if (!workforce.updateWorker(agencyId, employeeId, patch, actor.id)) {
          throw new Error("employee not found");
        }
      }

      const profilePatch =
        opts.params.profile && typeof opts.params.profile === "object"
          ? (opts.params.profile as Record<string, unknown>)
          : {};
      const result = workforce.setExecutionProfile(agencyId, employeeId, profilePatch, actor.id);
      if (!result) throw new Error("employee not found");
      return {
        employeeId,
        profile: result.profile,
        changed: result.changed || Object.keys(patch).length > 0,
        modelBinding: result.worker.modelBinding,
        autonomyLevel: result.worker.autonomyLevel,
        approvalThreshold: result.worker.approvalThreshold,
        capabilities: result.worker.capabilities,
      };
    }),

  "agency.ops.sop.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = workforceSopStore();
      const slug = optionalString(opts.params.slug);
      const sopId = optionalString(opts.params.sopId);
      if (!sopId && !slug) throw new Error("sopId or slug required");
      const sop = sopId ? store.getSop(agencyId, sopId) : store.getSopBySlug(agencyId, slug!);
      if (!sop) throw new Error("SOP not found");
      return {
        sop: sopPayload(sop),
        schedules: store.listSchedules(agencyId, { sopId: sop.id }),
        runs: store.listRuns(agencyId, { sopId: sop.id, limit: 20 }),
      };
    }),

  "agency.ops.sop.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const name = stringParam(opts.params.name, "name");
      const sop = workforceSopStore().createSop(agencyId, {
        slug: optionalString(opts.params.slug) ?? name,
        name,
        summary: optionalString(opts.params.summary),
        ownerWorkerId: optionalString(opts.params.ownerWorkerId) ?? null,
        ownerRoleId: optionalString(opts.params.ownerRoleId) ?? null,
        category: optionalString(opts.params.category),
        status: optionalString(opts.params.status) as SopStatus | undefined,
        steps: sopStepsParam(opts.params.steps),
        inputs: sopIoParam(opts.params.inputs),
        outputs: sopIoParam(opts.params.outputs),
        acceptanceCriteria: stringListParam(opts.params.acceptanceCriteria),
        tags: stringListParam(opts.params.tags),
        defaultPriority: optionalString(opts.params.defaultPriority) as
          | WorkItemPriority
          | undefined,
        estimatedMinutes:
          typeof opts.params.estimatedMinutes === "number"
            ? opts.params.estimatedMinutes
            : undefined,
        source: "operator",
      });
      workforceStore().recordAudit(agencyId, actor.id, "sop.created", "sop", sop.id, null, sop);
      return { sop: sopPayload(sop) };
    }),

  "agency.ops.sop.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const sopId = stringParam(opts.params.sopId, "sopId");
      const store = workforceSopStore();
      const before = store.getSop(agencyId, sopId);
      if (!before) throw new Error("SOP not found");
      const sop = store.updateSop(agencyId, sopId, {
        ...(opts.params.slug !== undefined ? { slug: stringParam(opts.params.slug, "slug") } : {}),
        ...(opts.params.name !== undefined ? { name: stringParam(opts.params.name, "name") } : {}),
        ...(opts.params.summary !== undefined
          ? { summary: String(opts.params.summary ?? "") }
          : {}),
        ...(opts.params.ownerWorkerId !== undefined
          ? { ownerWorkerId: optionalString(opts.params.ownerWorkerId) ?? null }
          : {}),
        ...(opts.params.category !== undefined
          ? { category: String(opts.params.category ?? "") }
          : {}),
        ...(opts.params.status !== undefined
          ? { status: String(opts.params.status) as SopStatus }
          : {}),
        ...(opts.params.steps !== undefined ? { steps: sopStepsParam(opts.params.steps) } : {}),
        ...(opts.params.inputs !== undefined ? { inputs: sopIoParam(opts.params.inputs) } : {}),
        ...(opts.params.outputs !== undefined ? { outputs: sopIoParam(opts.params.outputs) } : {}),
        ...(opts.params.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: stringListParam(opts.params.acceptanceCriteria) }
          : {}),
        ...(opts.params.tags !== undefined ? { tags: stringListParam(opts.params.tags) } : {}),
        ...(opts.params.defaultPriority !== undefined
          ? { defaultPriority: String(opts.params.defaultPriority) as WorkItemPriority }
          : {}),
        ...(typeof opts.params.estimatedMinutes === "number"
          ? { estimatedMinutes: opts.params.estimatedMinutes }
          : {}),
      });
      if (!sop) throw new Error("SOP not found");
      // `updateSop` returns the row untouched on a genuine no-op; do not audit.
      if (sop.updatedAt !== before.updatedAt) {
        workforceStore().recordAudit(agencyId, actor.id, "sop.updated", "sop", sop.id, before, sop);
      }
      return { sop: sopPayload(sop) };
    }),

  /**
   * Delete an SOP. Its schedules cascade, so the cron jobs and recurring
   * responsibilities behind them are torn down first — otherwise the agency
   * would keep generating work for a procedure that no longer exists.
   */
  "agency.ops.sop.delete": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const sopId = stringParam(opts.params.sopId, "sopId");
      const store = workforceSopStore();
      const before = store.getSop(agencyId, sopId);
      if (!before) return { deleted: false };
      const deps = sopServiceDeps(opts);
      for (const schedule of store.listSchedules(agencyId, { sopId })) {
        await detachSopSchedule(deps, agencyId, schedule.id);
      }
      const deleted = store.deleteSop(agencyId, sopId);
      if (deleted) {
        workforceStore().recordAudit(agencyId, actor.id, "sop.deleted", "sop", sopId, before, null);
      }
      return { deleted };
    }),

  "agency.ops.sop.schedules.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        schedules: workforceSopStore().listSchedules(agencyId, {
          sopId: optionalString(opts.params.sopId),
          workerId: optionalString(opts.params.workerId),
          enabled: typeof opts.params.enabled === "boolean" ? opts.params.enabled : undefined,
        }),
      };
    }),

  /**
   * Bind an SOP to an employee on a cadence. Produces a real cron job (category
   * `agency:sop`, visible and pausable in Settings) and the recurring
   * responsibility the operating loop ticks into Backlog work.
   *
   * Idempotent: re-attaching identical settings writes nothing and never
   * duplicates the cron job or clobbers operator edits to it.
   */
  "agency.ops.sop.schedule.attach": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const input: SopScheduleInput = {
        sopId: stringParam(opts.params.sopId, "sopId"),
        workerId: stringParam(opts.params.workerId, "workerId"),
        managerWorkerId: optionalString(opts.params.managerWorkerId) ?? null,
        cadence: optionalString(opts.params.cadence) as SopCadence | undefined,
        interval: typeof opts.params.interval === "number" ? opts.params.interval : undefined,
        weekday: typeof opts.params.weekday === "number" ? opts.params.weekday : null,
        monthDay: typeof opts.params.monthDay === "number" ? opts.params.monthDay : null,
        runAt: optionalString(opts.params.runAt),
        timezone: optionalString(opts.params.timezone),
        slaMinutes: typeof opts.params.slaMinutes === "number" ? opts.params.slaMinutes : undefined,
        priority: optionalString(opts.params.priority) as WorkItemPriority | undefined,
        enabled: typeof opts.params.enabled === "boolean" ? opts.params.enabled : undefined,
        // Guarded on purpose: a 0 here used to persist as the Unix epoch.
        nextRunAt:
          typeof opts.params.nextRunAt === "number" && opts.params.nextRunAt > 0
            ? opts.params.nextRunAt
            : undefined,
      };
      const result = await attachSopSchedule(sopServiceDeps(opts), agencyId, input);
      if (result.changed) {
        workforceStore().recordAudit(
          agencyId,
          actor.id,
          "sop.schedule.attached",
          "sop_schedule",
          result.schedule.id,
          null,
          {
            sopId: result.sop.id,
            workerId: result.schedule.workerId,
            cronJobName: result.schedule.cronJobName,
            responsibilityId: result.schedule.responsibilityId,
            nextRunAt: result.schedule.nextRunAt,
          },
        );
      }
      return {
        schedule: result.schedule,
        responsibility: result.responsibility,
        cronJob: result.cronJob,
        cronJobCreated: result.cronJobCreated,
        changed: result.changed,
      };
    }),

  "agency.ops.sop.schedule.detach": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const scheduleId = stringParam(opts.params.scheduleId, "scheduleId");
      const result = await detachSopSchedule(sopServiceDeps(opts), agencyId, scheduleId);
      if (result.schedule) {
        workforceStore().recordAudit(
          agencyId,
          actor.id,
          "sop.schedule.detached",
          "sop_schedule",
          scheduleId,
          result.schedule,
          null,
        );
      }
      return {
        detached: result.schedule !== null,
        responsibilityRemoved: result.responsibilityRemoved,
        cronJobRemoved: result.cronJobRemoved,
      };
    }),

  /**
   * Fire an SOP once — "run now", or "run at" a future timestamp.
   *
   * Produces exactly one Backlog (`queued`) work item. It is NEVER staged into
   * `accepted`: that column is the human authorisation gate for spawning a
   * coder CLI, and nothing automated may cross it.
   */
  "agency.ops.sop.run": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const result = runSopOnce(sopServiceDeps(opts), agencyId, {
        sopId: stringParam(opts.params.sopId, "sopId"),
        workerId: optionalString(opts.params.workerId),
        managerWorkerId: optionalString(opts.params.managerWorkerId) ?? null,
        runAt:
          typeof opts.params.runAt === "number" && opts.params.runAt > 0
            ? opts.params.runAt
            : undefined,
        priority: optionalString(opts.params.priority) as WorkItemPriority | undefined,
        slaMinutes: typeof opts.params.slaMinutes === "number" ? opts.params.slaMinutes : undefined,
        note: optionalString(opts.params.note) ?? null,
      });
      workforceStore().recordAudit(agencyId, actor.id, "sop.run", "sop_run", result.run.id, null, {
        sopId: result.sop.id,
        workItemId: result.workItem.id,
        status: result.workItem.status,
      });
      return { run: result.run, workItem: result.workItem };
    }),

  "agency.ops.sop.runs.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        runs: workforceSopStore().listRuns(agencyId, {
          sopId: optionalString(opts.params.sopId),
          scheduleId: optionalString(opts.params.scheduleId),
          workerId: optionalString(opts.params.workerId),
          limit: numberParam(opts.params.limit, 100),
        }),
      };
    }),

  "agency.ops.funnels.overview": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      ensureLegacyFunnelBridge(agencyId);
      return {
        overview: agencyFunnelStore().getOverview(agencyId, optionalString(opts.params.funnelId)),
      };
    }),

  "agency.ops.funnels.context": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      ensureLegacyFunnelBridge(agencyId);
      return {
        context: agencyFunnelStore().getCoreOperatingContext(
          agencyId,
          optionalString(opts.params.funnelId),
        ),
      };
    }),

  "agency.ops.funnels.map.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const funnelId = resolveAgencyFunnelId(agencyId, optionalString(opts.params.funnelId));
      if (!funnelId) return { funnel: null, nodes: [], edges: [] };
      const store = agencyFunnelStore();
      return {
        funnel: store.getFunnel(agencyId, funnelId),
        nodes: store.listNodes(agencyId, funnelId),
        edges: store.listEdges(agencyId, funnelId),
      };
    }),

  "agency.ops.funnels.map.upsert": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const store = agencyFunnelStore();
      let funnelId = resolveAgencyFunnelId(agencyId, optionalString(opts.params.funnelId));
      if (!funnelId) {
        funnelId = store.createFunnel(agencyId, {
          name: optionalString(opts.params.name) ?? "Agency Core Funnel",
          description: optionalString(opts.params.description),
          kind: "sales",
          ownerId: actor.id,
          objective:
            optionalString(opts.params.objective) ??
            "Turn qualified demand into successful, retained clients.",
        }).id;
      }
      const existingNodeIds = new Set(store.listNodes(agencyId, funnelId).map((node) => node.id));
      for (const raw of Array.isArray(opts.params.nodes) ? opts.params.nodes : []) {
        if (!raw || typeof raw !== "object") continue;
        const node = raw as Record<string, unknown>;
        const id = optionalString(node.id);
        if (id && existingNodeIds.has(id)) continue;
        store.createNode(agencyId, funnelId, {
          id,
          nodeType: (optionalString(node.nodeType) ?? "action") as AgencyFunnelNodeType,
          name: optionalString(node.name) ?? "Untitled step",
          description: optionalString(node.description),
          config:
            node.config && typeof node.config === "object"
              ? (node.config as Record<string, unknown>)
              : {},
          positionX: numberParam(node.positionX),
          positionY: numberParam(node.positionY),
          sortOrder: numberParam(node.sortOrder),
          enabled: node.enabled !== false,
        });
      }
      const existingEdgeKeys = new Set(
        store
          .listEdges(agencyId, funnelId)
          .map((edge) => `${edge.sourceNodeId}:${edge.targetNodeId}:${edge.label ?? ""}`),
      );
      for (const raw of Array.isArray(opts.params.edges) ? opts.params.edges : []) {
        if (!raw || typeof raw !== "object") continue;
        const edge = raw as Record<string, unknown>;
        const sourceNodeId = stringParam(edge.sourceNodeId, "sourceNodeId");
        const targetNodeId = stringParam(edge.targetNodeId, "targetNodeId");
        const label = optionalString(edge.label);
        if (existingEdgeKeys.has(`${sourceNodeId}:${targetNodeId}:${label ?? ""}`)) continue;
        store.createEdge(agencyId, funnelId, {
          sourceNodeId,
          targetNodeId,
          label,
          condition:
            edge.condition && typeof edge.condition === "object"
              ? (edge.condition as Record<string, unknown>)
              : {},
          priority: numberParam(edge.priority),
          enabled: edge.enabled !== false,
        });
      }
      return { overview: store.getOverview(agencyId, funnelId) };
    }),

  "agency.ops.funnels.connection.upsert": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const funnelId = resolveAgencyFunnelId(agencyId, optionalString(opts.params.funnelId));
      if (!funnelId) throw new Error("core funnel required");
      const connection =
        opts.params.connection && typeof opts.params.connection === "object"
          ? (opts.params.connection as Record<string, unknown>)
          : opts.params;
      return {
        connection: agencyFunnelStore().upsertConnection(agencyId, funnelId, {
          id: optionalString(connection.id),
          nodeId: optionalString(connection.nodeId),
          provider: stringParam(connection.provider, "provider"),
          connectionKey: stringParam(connection.connectionKey, "connectionKey"),
          status: optionalString(connection.status) as
            | "disconnected"
            | "configuring"
            | "connected"
            | "degraded"
            | "error"
            | undefined,
          config:
            connection.config && typeof connection.config === "object"
              ? (connection.config as Record<string, unknown>)
              : {},
          lastError: optionalString(connection.lastError),
        }),
      };
    }),

  "agency.ops.funnels.connection.check": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const funnelId = resolveAgencyFunnelId(agencyId, optionalString(opts.params.funnelId));
      if (!funnelId) throw new Error("core funnel required");
      const connectionId = stringParam(opts.params.connectionId, "connectionId");
      const connection = agencyFunnelStore()
        .listConnections(agencyId, funnelId)
        .find((item) => item.id === connectionId);
      if (!connection) throw new Error("connection not found");
      const result = await funnelHealth.check(connection);
      return {
        check: agencyFunnelStore().recordHealthCheck(agencyId, funnelId, {
          targetType: "connection",
          targetId: connection.id,
          status: result.status,
          message: result.message,
          latencyMs: result.latencyMs ?? undefined,
          details: result.details,
        }),
      };
    }),

  "agency.ops.funnels.health.check": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const funnelId = resolveAgencyFunnelId(agencyId, optionalString(opts.params.funnelId));
      if (!funnelId) return { overview: agencyFunnelStore().getOverview(agencyId) };
      const store = agencyFunnelStore();
      for (const connection of store.listConnections(agencyId, funnelId)) {
        const result = await funnelHealth.check(connection);
        store.recordHealthCheck(agencyId, funnelId, {
          targetType: "connection",
          targetId: connection.id,
          status: result.status,
          message: result.message,
          latencyMs: result.latencyMs ?? undefined,
          details: result.details,
        });
      }
      const critical = store
        .detectGaps(agencyId, funnelId)
        .filter((gap) => gap.severity === "critical");
      store.recordHealthCheck(agencyId, funnelId, {
        targetType: "funnel",
        targetId: funnelId,
        status: critical.length ? "unhealthy" : "healthy",
        message: critical.length
          ? `${critical.length} critical readiness gap(s)`
          : "No critical readiness gaps",
        details: { criticalGapCount: critical.length },
      });
      return { overview: store.getOverview(agencyId, funnelId) };
    }),

  "agency.ops.funnels.kpi.record": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        reading: agencyFunnelStore().recordKpi(
          agencyId,
          stringParam(opts.params.kpiId, "kpiId"),
          numberParam(opts.params.value),
          {
            recordedAt:
              typeof opts.params.recordedAt === "number" ? opts.params.recordedAt : undefined,
          },
        ),
      };
    }),

  // Canonical agency-scoped primitives used by Projects/Tasks/CRM adapters.
  "agency.ops.clients.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = operationsStore();
      const projects = store.listProjects(agencyId);
      const invoices = store.listInvoices(agencyId);
      const profiles = new Map(
        store.listClientRevenueProfiles(agencyId).map((profile) => [profile.clientId, profile]),
      );
      // Filter by the real pipeline status. Accepts a single value or a list;
      // matching is case- and whitespace-insensitive.
      const requestedPipeline = opts.params.pipelineStatus;
      const pipelineStatus = Array.isArray(requestedPipeline)
        ? requestedPipeline.filter((value): value is string => typeof value === "string")
        : optionalString(requestedPipeline);
      const rollup = optionalString(opts.params.status);
      if (rollup && !["prospect", "active", "inactive"].includes(rollup)) {
        throw new Error("invalid client status");
      }
      return {
        // Always the full distribution for the agency, unaffected by the
        // filter above, so a status-grouped board can render every column
        // (including the empty ones) from one call.
        pipelineStatuses: store.listClientPipelineStatusCounts(agencyId),
        knownPipelineStatuses: KNOWN_CLIENT_PIPELINE_STATUSES,
        clients: store
          .listClients(agencyId, {
            pipelineStatus: pipelineStatus === undefined ? undefined : pipelineStatus,
            status: rollup as "prospect" | "active" | "inactive" | undefined,
          })
          .map((client) => {
            const clientInvoices = invoices.filter((invoice) => invoice.clientId === client.id);
            return {
              ...client,
              projectCount: projects.filter((project) => project.clientId === client.id).length,
              invoiceCount: clientInvoices.length,
              lifetimeInvoicedCents: clientInvoices.reduce(
                (sum, invoice) => sum + invoice.totalCents,
                0,
              ),
              outstandingCents: clientInvoices.reduce(
                (sum, invoice) => sum + invoice.balanceCents,
                0,
              ),
              mrrCents: profiles.get(client.id)?.mrrCents ?? 0,
            };
          }),
      };
    }),
  "agency.ops.clients.source.status": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const legacy =
        (operationsStore().getAgencyProfile(agencyId)?.legacySnapshot as Record<
          string,
          unknown
        > | null) ?? {};
      const schema = legacy.crmSchema;
      return {
        connected: Boolean(legacy.crmDatabaseId),
        databaseName: typeof legacy.crmDatabaseName === "string" ? legacy.crmDatabaseName : null,
        lastSync: typeof legacy.crmLastSync === "number" ? legacy.crmLastSync : null,
        notionConfigured: Boolean(legacy.crmDatabaseId),
        schemaPropertyCount: schema && typeof schema === "object" ? Object.keys(schema).length : 0,
      };
    }),
  "agency.ops.clients.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        client: operationsStore().createClient(
          {
            name: stringParam(opts.params.name, "name"),
            billingEmail: optionalString(opts.params.billingEmail),
            pipelineStatus: clientPipelineStatusParam(opts.params.pipelineStatus),
          },
          { agencyId, actorId: actor.id },
        ),
      };
    }),
  "agency.ops.clients.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const status = optionalString(opts.params.status);
      if (status && !["prospect", "active", "inactive"].includes(status)) {
        throw new Error("invalid client status");
      }
      const pipelineStatus = clientPipelineStatusParam(opts.params.pipelineStatus);
      // A contact field is written when the param is present at all: an
      // explicit `null` clears it, a string sets it, `undefined` leaves it be.
      const contactField = (value: unknown): string | null | undefined =>
        value === null ? null : optionalString(value);
      const client = operationsStore().updateClient(
        stringParam(opts.params.clientId, "clientId"),
        {
          name: optionalString(opts.params.name),
          status: status as "prospect" | "active" | "inactive" | undefined,
          pipelineStatus,
          billingEmail:
            opts.params.billingEmail === null ? null : optionalString(opts.params.billingEmail),
          notes: opts.params.notes === null ? null : optionalString(opts.params.notes),
          email: contactField(opts.params.email),
          phone: contactField(opts.params.phone),
          whatsapp: contactField(opts.params.whatsapp),
          telegram: contactField(opts.params.telegram),
          discord: contactField(opts.params.discord),
          instagram: contactField(opts.params.instagram),
        },
        { agencyId, actorId: actor.id },
      );
      return {
        client,
        // A status this build has not seen is stored, not rejected. The flag
        // lets the UI surface "new status" without failing the write.
        pipelineStatusKnown: isKnownClientPipelineStatus(client.pipelineStatus),
      };
    }),
  "agency.ops.projects.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        projects: operationsStore().listProjects(
          agencyId,
          optionalString(opts.params.status) as AgencyProjectStatus | undefined,
        ),
      };
    }),
  "agency.ops.projects.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        project: operationsStore().createProject(
          agencyId,
          {
            name: stringParam(opts.params.name, "name"),
            clientId: optionalString(opts.params.clientId),
            budgetCents: cents(opts.params.budget),
          },
          actor.id,
        ),
      };
    }),
  "agency.ops.projects.transition": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const status = stringParam(opts.params.status, "status") as AgencyProjectStatus;
      if (!["planned", "active", "on_hold", "completed", "cancelled"].includes(status)) {
        throw new Error("invalid project status");
      }
      return {
        project: operationsStore().transitionProject(
          agencyId,
          stringParam(opts.params.projectId, "projectId"),
          status,
          actor.id,
        ),
      };
    }),
  // Thin wrapper over the already-tested `operationsStore().updateProject`.
  // Only keys the caller actually sent are forwarded, so a partial edit (rename
  // only, budget only, clear-deadline only) never clobbers the untouched
  // fields. Status stays on `agency.ops.projects.transition`; this handles the
  // descriptive fields the edit dialog exposes.
  "agency.ops.projects.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const patch: {
        name?: string;
        ownerId?: string | null;
        targetEndAt?: number | null;
        budgetCents?: number;
      } = {};
      if ("name" in opts.params && opts.params.name !== undefined) {
        patch.name = stringParam(opts.params.name, "name");
      }
      if ("ownerId" in opts.params) {
        patch.ownerId = optionalString(opts.params.ownerId) ?? null;
      }
      if ("targetEndAt" in opts.params) {
        const raw = opts.params.targetEndAt;
        patch.targetEndAt = raw == null ? null : numberParam(raw);
      }
      if ("budget" in opts.params && opts.params.budget !== undefined) {
        patch.budgetCents = cents(opts.params.budget);
      } else if ("budgetCents" in opts.params && opts.params.budgetCents !== undefined) {
        patch.budgetCents = numberParam(opts.params.budgetCents);
      }
      return {
        project: operationsStore().updateProject(
          agencyId,
          stringParam(opts.params.projectId, "projectId"),
          patch,
          actor.id,
        ),
      };
    }),
  "agency.ops.client.mrr.set": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const profile = operationsStore().setClientMrr(
        agencyId,
        stringParam(opts.params.clientId, "clientId"),
        centsParam(opts.params.mrrCents, "mrrCents"),
        optionalString(opts.params.currency),
      );
      return { profile };
    }),
  "agency.ops.project.mrr.set": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        project: operationsStore().setProjectMrr(
          agencyId,
          stringParam(opts.params.projectId, "projectId"),
          centsParam(opts.params.mrrCents, "mrrCents"),
          actor.id,
        ),
      };
    }),
  "agency.ops.tasks.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        tasks: operationsStore().listTasks(agencyId, {
          projectId: optionalString(opts.params.projectId),
          status: optionalString(opts.params.status) as AgencyTaskStatus | undefined,
          assigneeId: optionalString(opts.params.assigneeId),
        }),
      };
    }),
  "agency.ops.tasks.create": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        task: operationsStore().createTask(
          agencyId,
          {
            projectId: stringParam(opts.params.projectId, "projectId"),
            title: stringParam(opts.params.title, "title"),
            description: optionalString(opts.params.description),
            acceptanceCriteria:
              optionalString(opts.params.acceptanceCriteria) ?? "Reviewed and accepted by owner",
            assigneeType: optionalString(opts.params.assigneeType) as
              | "human"
              | "ai"
              | "hybrid"
              | undefined,
            assigneeId: optionalString(opts.params.assigneeId),
          },
          actor.id,
        ),
      };
    }),
  "agency.ops.tasks.transition": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const status = stringParam(opts.params.status, "status") as AgencyTaskStatus;
      if (
        !["backlog", "ready", "in_progress", "blocked", "review", "done", "cancelled"].includes(
          status,
        )
      ) {
        throw new Error("invalid task status");
      }
      return {
        task: operationsStore().transitionTask(
          agencyId,
          stringParam(opts.params.taskId, "taskId"),
          status,
          actor.id,
        ),
      };
    }),
  "agency.ops.tasks.assign": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const assigneeId = optionalString(opts.params.assigneeId);
      const assigneeType = optionalString(opts.params.assigneeType) as
        | "human"
        | "ai"
        | "hybrid"
        | undefined;
      return {
        task: operationsStore().updateTask(
          agencyId,
          stringParam(opts.params.taskId, "taskId"),
          {
            assigneeId: assigneeId ?? null,
            assigneeType: assigneeId ? (assigneeType ?? "human") : null,
          },
          actor.id,
        ),
      };
    }),

  // Thin wrapper over the already-tested `operationsStore().updateTask`. Status
  // stays on `agency.ops.tasks.transition` and assignee on `.tasks.assign`;
  // this persists the descriptive fields (title, description, priority, due
  // date) the task edit dialog exposes. Only sent keys are forwarded.
  "agency.ops.tasks.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const patch: {
        title?: string;
        description?: string;
        priority?: "low" | "normal" | "high" | "urgent";
        assigneeType?: "human" | "ai" | "hybrid" | null;
        assigneeId?: string | null;
        dueAt?: number | null;
      } = {};
      if ("title" in opts.params && opts.params.title !== undefined) {
        patch.title = stringParam(opts.params.title, "title");
      }
      if ("description" in opts.params) {
        patch.description = optionalString(opts.params.description) ?? "";
      }
      if ("priority" in opts.params && opts.params.priority !== undefined) {
        const priority = stringParam(opts.params.priority, "priority");
        if (!["low", "normal", "high", "urgent"].includes(priority)) {
          throw new Error("invalid task priority");
        }
        patch.priority = priority as "low" | "normal" | "high" | "urgent";
      }
      if ("dueAt" in opts.params) {
        const raw = opts.params.dueAt;
        patch.dueAt = raw == null ? null : numberParam(raw);
      }
      if ("assigneeId" in opts.params) {
        const assigneeId = optionalString(opts.params.assigneeId) ?? null;
        patch.assigneeId = assigneeId;
        if (assigneeId) {
          const assigneeType = optionalString(opts.params.assigneeType) as
            | "human"
            | "ai"
            | "hybrid"
            | undefined;
          patch.assigneeType = assigneeType ?? "human";
        } else {
          patch.assigneeType = null;
        }
      }
      return {
        task: operationsStore().updateTask(
          agencyId,
          stringParam(opts.params.taskId, "taskId"),
          patch,
          actor.id,
        ),
      };
    }),

  // ── Automatic task routing ────────────────────────────────────────────────
  //
  // The bridge between real agency work (`agency_tasks`) and the AI workforce.
  // Scoring reuses `scoreWorkerSuitability`; every decision persists its own
  // rationale so an operator can audit and correct it. Work the router cannot
  // confidently place is left UNASSIGNED and surfaced, never force-fitted.

  /**
   * Dry run. Exactly what WOULD be assigned, to whom, and why. Writes nothing:
   * no decisions, no work items, no task updates, no audit rows.
   */
  "agency.ops.routing.preview": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        routing: previewTaskRouting(taskRouterDeps(), agencyId, {
          limits: routingLimitOverrides(opts.params),
          mode: autostageModeParam(opts.params.mode),
          maxDecisionsReturned: numberParam(opts.params.limit, 100),
          force: opts.params.force === true,
        }),
      };
    }),

  /**
   * Apply routing for real. Idempotent and incremental: a second call with
   * nothing changed reports `writes: 0` and touches no table.
   */
  "agency.ops.routing.apply": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        routing: applyTaskRouting(taskRouterDeps(opts), agencyId, {
          limits: routingLimitOverrides(opts.params),
          mode: autostageModeParam(opts.params.mode),
          maxDecisionsReturned: numberParam(opts.params.limit, 100),
          force: opts.params.force === true,
          actorId: actor.id,
        }),
      };
    }),

  /** Every routing decision with its rationale, plus the agency's counts. */
  "agency.ops.routing.decisions.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const store = workforceRoutingStore();
      return {
        decisions: store.listDecisions(agencyId, {
          workerId: optionalString(opts.params.workerId),
          outcome: optionalString(opts.params.outcome) as TaskRoutingOutcome | undefined,
          needsHuman:
            typeof opts.params.needsHuman === "boolean" ? opts.params.needsHuman : undefined,
          stageRecommended:
            typeof opts.params.stageRecommended === "boolean"
              ? opts.params.stageRecommended
              : undefined,
          autoStaged:
            typeof opts.params.autoStaged === "boolean" ? opts.params.autoStaged : undefined,
          limit: numberParam(opts.params.limit, 100),
          offset: numberParam(opts.params.offset, 0),
        }),
        counts: store.countDecisions(agencyId),
        policy: store.getPolicy(agencyId),
      };
    }),

  /**
   * Operator override. The resulting decision is PINNED: the router never
   * revisits a task a human has ruled on.
   */
  "agency.ops.routing.task.assign": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        decision: overrideTaskRouting(taskRouterDeps(opts), agencyId, {
          taskId: stringParam(opts.params.taskId, "taskId"),
          workerId: stringParam(opts.params.workerId, "workerId"),
          note: optionalString(opts.params.note),
          actorId: actor.id,
        }),
      };
    }),

  /**
   * Remove an assignment. Also pinned, so the router does not helpfully refill
   * the gap on the next tick. Pass `unpin: true` to hand it back to the router.
   */
  "agency.ops.routing.task.unassign": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        decision: unassignTask(taskRouterDeps(opts), agencyId, {
          taskId: stringParam(opts.params.taskId, "taskId"),
          note: optionalString(opts.params.note),
          unpin: opts.params.unpin === true,
          actorId: actor.id,
        }),
      };
    }),

  /**
   * Stage a BATCH of routed cards in one action — "start everything recommended
   * for Wren" instead of twenty clicks. Cards owned by an autonomy-0 employee
   * are refused: they can never execute, so staging them would just move them
   * into a column they cannot leave.
   */
  "agency.ops.routing.stage": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        result: stageRoutedWork(taskRouterDeps(opts), agencyId, {
          workerId: optionalString(opts.params.workerId),
          taskIds: stringListParam(opts.params.taskIds),
          limit: numberParam(opts.params.limit, 50),
          actorId: actor.id,
        }),
      };
    }),

  /** The routing + autostage policy, with the shipped defaults for reference. */
  "agency.ops.routing.policy.get": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return {
        policy: workforceRoutingStore().getPolicy(agencyId),
        defaults: DEFAULT_TASK_ROUTING_POLICY,
        modes: TASK_AUTOSTAGE_MODES,
      };
    }),

  /**
   * Dial autonomy between "route only" and "route and stage", agency-wide or
   * per employee. Every bound is real: `maxAutoStagePerPass` and
   * `maxAutoStagePerDay` are what stop a 2,853-task backlog becoming 2,853
   * concurrent coder runs.
   */
  "agency.ops.routing.policy.update": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const workerModes =
        opts.params.workerModes && typeof opts.params.workerModes === "object"
          ? Object.fromEntries(
              Object.entries(opts.params.workerModes as Record<string, unknown>).map(
                ([workerId, value]) => [
                  workerId,
                  value === null ? null : (autostageModeParam(value) ?? null),
                ],
              ),
            )
          : undefined;
      const before = workforceRoutingStore().getPolicy(agencyId);
      const policy = workforceRoutingStore().setPolicy(agencyId, {
        enabled: typeof opts.params.enabled === "boolean" ? opts.params.enabled : undefined,
        mode: autostageModeParam(opts.params.mode),
        minConfidence:
          typeof opts.params.minConfidence === "number" ? opts.params.minConfidence : undefined,
        minAutonomyLevel:
          typeof opts.params.minAutonomyLevel === "number"
            ? (opts.params.minAutonomyLevel as 0 | 1 | 2 | 3)
            : undefined,
        maxAutoStagePerPass:
          typeof opts.params.maxAutoStagePerPass === "number"
            ? opts.params.maxAutoStagePerPass
            : undefined,
        maxAutoStagePerDay:
          typeof opts.params.maxAutoStagePerDay === "number"
            ? opts.params.maxAutoStagePerDay
            : undefined,
        ...routingLimitOverrides(opts.params),
        workerModes,
      });
      workforceStore().recordAudit(
        agencyId,
        actor.id,
        "task.routing.policy.updated",
        "task_routing",
        agencyId,
        before,
        policy,
      );
      return { policy };
    }),

  // ── First-run provisioning ────────────────────────────────────────────────

  /** Which provisioning steps have run, and at what version. Read-only. */
  "agency.ops.provisioning.status": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return { status: agencyProvisioningStatus(workforceRoutingStore(), agencyId) };
    }),

  /**
   * Bring the agency up to the provisioning baseline now. Runs automatically on
   * agency bootstrap, on `agencies.list` and on every operating-loop pass; this
   * is the manual "do it now" for an operator who wants to watch it happen.
   */
  "agency.ops.provisioning.ensure": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      return {
        provisioning: await ensureAgencyProvisioned(provisioningDeps(opts), agencyId, actor.id),
      };
    }),

  // ── Relations (agency.db referential navigation) ─────────────────────────

  /** Walk one client to its contacts, projects, tasks, engagements, invoices. */
  "agency.ops.relations.client": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return operationsStore().getClientRelations(
        agencyId,
        stringParam(opts.params.clientId, "clientId"),
      );
    }),

  /** Walk one project back to its client, and out to its tasks and invoices. */
  "agency.ops.relations.project": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return operationsStore().getProjectRelations(
        agencyId,
        stringParam(opts.params.projectId, "projectId"),
      );
    }),

  /** Attach/detach a project to a client, enforcing single-agency scoping. */
  "agency.ops.relations.project.client.set": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        project: operationsStore().setProjectClient(
          agencyId,
          stringParam(opts.params.projectId, "projectId"),
          opts.params.clientId === null ? null : stringParam(opts.params.clientId, "clientId"),
          actor.id,
        ),
      };
    }),

  /** Orphan / cross-tenant / dangling-link report over the relation graph. */
  "agency.ops.relations.integrity": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return operationsStore().checkRelationIntegrity(agencyId);
    }),

  // ── Notion mirror (agency.db is the source of truth) ─────────────────────

  /** Notion databases visible to the configured integration. */
  "agency.ops.notion.databases.list": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        databases: await listNotionDatabases(notionTransport(), numberParam(opts.params.limit, 50)),
      };
    }),

  /** Bind a Notion database to one agency entity type. */
  "agency.ops.notion.connect": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      const result = await connectAgencyNotionDatabase(
        operationsStore(),
        {
          agencyId,
          entityType: externalEntityTypeParam(opts.params.entityType),
          databaseId: stringParam(opts.params.databaseId, "databaseId"),
          databaseName: optionalString(opts.params.databaseName) ?? null,
          syncDirection: externalDirectionParam(opts.params.syncDirection),
          actorId: actor.id,
        },
        notionTransport(),
      );
      return {
        binding: result.binding,
        changed: result.changed,
        database: {
          id: result.meta.id,
          name: result.meta.name,
          url: result.meta.url,
          properties: result.meta.properties,
        },
        fieldMap: buildFieldMap(externalEntityTypeParam(opts.params.entityType), result.meta),
      };
    }),

  /** Unbind a Notion database and drop its links. Local rows are untouched. */
  "agency.ops.notion.disconnect": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin"]);
      return operationsStore().removeExternalBinding(
        agencyId,
        NOTION_PROVIDER,
        externalEntityTypeParam(opts.params.entityType),
        actor.id,
      );
    }),

  /**
   * Connected? last sync? drift? conflicts? — computed from agency.db alone,
   * so it is safe to poll and never depends on Notion being reachable.
   */
  "agency.ops.notion.status": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId);
      const store = operationsStore();
      seedNotionBindingsFromConfig(store, agencyId, actor.id);
      const entityTypes = store.externalSyncStatus(agencyId, NOTION_PROVIDER);
      return {
        provider: NOTION_PROVIDER,
        notionConfigured: Boolean(getNotionApiKeyForImport()),
        connected: entityTypes.some((entry) => entry.connected),
        driftDetected: entityTypes.some((entry) => entry.driftDetected),
        conflicts: entityTypes.reduce((sum, entry) => sum + entry.conflicts, 0),
        lastSyncAt: entityTypes.reduce<number | null>(
          (latest, entry) =>
            entry.lastSyncAt != null && (latest == null || entry.lastSyncAt > latest)
              ? entry.lastSyncAt
              : latest,
          null,
        ),
        entityTypes,
      };
    }),

  /** Notion → agency.db. */
  "agency.ops.notion.pull": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        report: await pullAgencyEntitiesFromNotion(
          operationsStore(),
          {
            agencyId,
            entityType: externalEntityTypeParam(opts.params.entityType),
            actorId: actor.id,
            limit: numberParam(opts.params.limit, 500),
          },
          notionTransport(),
        ),
      };
    }),

  /** agency.db → Notion. */
  "agency.ops.notion.push": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      return {
        report: await pushAgencyEntitiesToNotion(
          operationsStore(),
          {
            agencyId,
            entityType: externalEntityTypeParam(opts.params.entityType),
            actorId: actor.id,
            limit: numberParam(opts.params.limit, 500),
          },
          notionTransport(),
        ),
      };
    }),

  /**
   * Pull then push, for one entity type or every bound one. Records already in
   * sync cost neither a Notion write nor a database write.
   */
  "agency.ops.notion.sync": async (opts) =>
    run(opts, async () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      const actor = requireAccess(opts, agencyId, ["owner", "admin", "member"]);
      const store = operationsStore();
      // Auto-seed bindings from wizard config so callers never have to run
      // agency.ops.notion.connect manually when clientsDbId/projectsDbId/tasksDbId
      // are already stored in infinibot.json (single Notion sync per entity type).
      seedNotionBindingsFromConfig(store, agencyId, actor.id);
      const requested = optionalString(opts.params.entityType);
      const entityTypes = requested
        ? [externalEntityTypeParam(requested)]
        : store
            .listExternalBindings(agencyId, NOTION_PROVIDER)
            .map((binding) => binding.entityType);
      if (!entityTypes.length) throw new Error("no Notion database is connected");
      const transport = notionTransport();
      const results = [];
      for (const entityType of entityTypes) {
        results.push({
          entityType,
          ...(await syncAgencyEntitiesWithNotion(
            store,
            {
              agencyId,
              entityType,
              actorId: actor.id,
              limit: numberParam(opts.params.limit, 500),
            },
            transport,
          )),
        });
      }
      return { results };
    }),

  /** Raw link rows, for drift inspection in the UI. */
  "agency.ops.notion.links.list": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      const entityType = optionalString(opts.params.entityType);
      const syncState = optionalString(opts.params.syncState);
      return {
        links: operationsStore().listExternalLinks(agencyId, {
          provider: NOTION_PROVIDER,
          entityType: entityType ? externalEntityTypeParam(entityType) : undefined,
          syncState: syncState as ExternalSyncState | undefined,
          limit: numberParam(opts.params.limit, 500),
        }),
      };
    }),

  /** Drift verdict for a single entity, without contacting the provider. */
  "agency.ops.notion.drift.check": async (opts) =>
    run(opts, () => {
      const agencyId = stringParam(opts.params.agencyId, "agencyId");
      requireAccess(opts, agencyId);
      return operationsStore().evaluateExternalDrift(
        agencyId,
        NOTION_PROVIDER,
        externalEntityTypeParam(opts.params.entityType),
        stringParam(opts.params.entityId, "entityId"),
      );
    }),
};

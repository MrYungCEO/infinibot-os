import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import type {
  AgencyFunnel,
  AgencyFunnelConnection,
  AgencyFunnelEdge,
  AgencyFunnelGap,
  AgencyFunnelHealthCheck,
  AgencyFunnelKind,
  AgencyFunnelKpiDefinition,
  AgencyFunnelKpiReading,
  AgencyFunnelNode,
  AgencyFunnelNodeType,
  AgencyFunnelOperatingContext,
  AgencyFunnelRequirement,
  AgencyFunnelStatus,
  FunnelHealthStatus,
  FunnelConnectionStatus,
  SetupRequirementKind,
  SetupRequirementStatus,
} from "./funnel-types.js";
import type { AgencyFunnelOverview } from "./funnel-rpc.js";

type Row = Record<string, unknown>;

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} required`);
  return normalized;
}

function camel(row: Row): any {
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) {
    result[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return result;
}

function parseJson(value: unknown): Record<string, any> {
  return typeof value === "string" && value ? JSON.parse(value) : {};
}

const statusTransitions: Record<AgencyFunnelStatus, AgencyFunnelStatus[]> = {
  draft: ["setup", "archived"],
  setup: ["draft", "ready", "archived"],
  ready: ["setup", "live", "archived"],
  live: ["degraded", "paused", "archived"],
  degraded: ["live", "paused", "archived"],
  paused: ["live", "archived"],
  archived: [],
};

export class AgencyFunnelStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agency_funnel_schema_migrations (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
      );
    `);
    const version = (
      this.db
        .prepare("SELECT COALESCE(MAX(version),0) version FROM agency_funnel_schema_migrations")
        .get() as { version: number }
    ).version;
    if (version >= 1) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE agency_funnels (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          parent_funnel_id TEXT REFERENCES agency_funnels(id) ON DELETE CASCADE,
          legacy_funnel_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL,
          status TEXT NOT NULL, owner_id TEXT, objective TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(agency_id, legacy_funnel_id)
        );
        CREATE INDEX agency_funnels_scope ON agency_funnels(agency_id,status,parent_funnel_id);
        CREATE TABLE agency_funnel_nodes (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE, node_type TEXT NOT NULL,
          name TEXT NOT NULL, description TEXT NOT NULL, config_json TEXT NOT NULL,
          position_x REAL NOT NULL, position_y REAL NOT NULL, sort_order INTEGER NOT NULL,
          enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX agency_funnel_nodes_scope ON agency_funnel_nodes(agency_id,funnel_id,sort_order);
        CREATE TABLE agency_funnel_edges (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE,
          source_node_id TEXT NOT NULL REFERENCES agency_funnel_nodes(id) ON DELETE CASCADE,
          target_node_id TEXT NOT NULL REFERENCES agency_funnel_nodes(id) ON DELETE CASCADE,
          label TEXT, condition_json TEXT NOT NULL, priority INTEGER NOT NULL, enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(funnel_id,source_node_id,target_node_id,label)
        );
        CREATE TABLE agency_funnel_connections (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE,
          node_id TEXT REFERENCES agency_funnel_nodes(id) ON DELETE CASCADE,
          provider TEXT NOT NULL, connection_key TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL,
          last_checked_at INTEGER, last_healthy_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(agency_id,connection_key)
        );
        CREATE TABLE agency_funnel_requirements (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE,
          node_id TEXT REFERENCES agency_funnel_nodes(id) ON DELETE CASCADE,
          connection_id TEXT REFERENCES agency_funnel_connections(id) ON DELETE SET NULL,
          kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, required INTEGER NOT NULL,
          status TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX agency_funnel_requirements_scope ON agency_funnel_requirements(agency_id,funnel_id,status);
        CREATE TABLE agency_funnel_health_checks (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
          latency_ms INTEGER, details_json TEXT NOT NULL, checked_at INTEGER NOT NULL
        );
        CREATE INDEX agency_funnel_health_latest ON agency_funnel_health_checks(agency_id,funnel_id,target_type,target_id,checked_at DESC);
        CREATE TABLE agency_funnel_kpis (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE,
          node_id TEXT REFERENCES agency_funnel_nodes(id) ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL,
          unit TEXT NOT NULL, aggregation TEXT NOT NULL, direction TEXT NOT NULL, target_value REAL,
          warning_value REAL, window_seconds INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(funnel_id,key)
        );
        CREATE TABLE agency_funnel_kpi_readings (
          id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
          funnel_id TEXT NOT NULL REFERENCES agency_funnels(id) ON DELETE CASCADE,
          kpi_id TEXT NOT NULL REFERENCES agency_funnel_kpis(id) ON DELETE CASCADE,
          value REAL NOT NULL, dimensions_json TEXT NOT NULL, recorded_at INTEGER NOT NULL
        );
        CREATE INDEX agency_funnel_kpi_readings_latest ON agency_funnel_kpi_readings(agency_id,kpi_id,recorded_at DESC);
      `);
      this.db
        .prepare("INSERT INTO agency_funnel_schema_migrations(version,applied_at) VALUES (1,?)")
        .run(Date.now());
    })();
  }

  createFunnel(
    agencyId: string,
    input: {
      id?: string;
      legacyFunnelId?: string;
      parentFunnelId?: string;
      name: string;
      description?: string;
      kind: AgencyFunnelKind;
      ownerId?: string;
      objective: string;
    },
  ): AgencyFunnel {
    this.requireAgency(agencyId);
    if (input.parentFunnelId && !this.getFunnel(agencyId, input.parentFunnelId))
      throw new Error("parent funnel not found");
    const now = Date.now();
    const funnel: AgencyFunnel = {
      id: input.id?.trim() || randomUUID(),
      agencyId,
      parentFunnelId: input.parentFunnelId ?? null,
      legacyFunnelId: input.legacyFunnelId?.trim() || null,
      name: required(input.name, "name"),
      description: input.description?.trim() ?? "",
      kind: input.kind,
      status: "draft",
      ownerId: input.ownerId ?? null,
      objective: required(input.objective, "objective"),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO agency_funnels VALUES (@id,@agencyId,@parentFunnelId,@legacyFunnelId,@name,@description,@kind,@status,@ownerId,@objective,@createdAt,@updatedAt)",
      )
      .run(funnel);
    return funnel;
  }

  createSubFunnel(
    agencyId: string,
    parentFunnelId: string,
    input: Omit<Parameters<AgencyFunnelStore["createFunnel"]>[1], "parentFunnelId">,
  ): AgencyFunnel {
    return this.createFunnel(agencyId, { ...input, parentFunnelId });
  }

  getFunnel(agencyId: string, idOrLegacyId: string): AgencyFunnel | null {
    const row = this.db
      .prepare("SELECT * FROM agency_funnels WHERE agency_id=? AND (id=? OR legacy_funnel_id=?)")
      .get(agencyId, idOrLegacyId, idOrLegacyId) as Row | undefined;
    return row ? this.mapFunnel(row) : null;
  }

  listFunnels(
    agencyId: string,
    input?: { status?: AgencyFunnelStatus; parentFunnelId?: string | null },
  ): AgencyFunnel[] {
    this.requireAgency(agencyId);
    let sql = "SELECT * FROM agency_funnels WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (input?.status) {
      sql += " AND status=?";
      params.push(input.status);
    }
    if (input && "parentFunnelId" in input) {
      if (input.parentFunnelId == null) sql += " AND parent_funnel_id IS NULL";
      else {
        sql += " AND parent_funnel_id=?";
        params.push(input.parentFunnelId);
      }
    }
    return (this.db.prepare(`${sql} ORDER BY updated_at DESC`).all(...params) as Row[]).map((r) =>
      this.mapFunnel(r),
    );
  }

  transitionFunnel(agencyId: string, id: string, status: AgencyFunnelStatus): AgencyFunnel {
    const funnel = this.mustFunnel(agencyId, id);
    if (!statusTransitions[funnel.status].includes(status))
      throw new Error(`Invalid funnel transition: ${funnel.status} -> ${status}`);
    if (status === "ready" || status === "live") {
      const critical = this.detectGaps(agencyId, id).filter((gap) => gap.severity === "critical");
      if (critical.length)
        throw new Error(`funnel has ${critical.length} critical readiness gap(s)`);
    }
    this.db
      .prepare("UPDATE agency_funnels SET status=?,updated_at=? WHERE agency_id=? AND id=?")
      .run(status, Date.now(), agencyId, funnel.id);
    return this.mustFunnel(agencyId, funnel.id);
  }

  /**
   * Idempotently mirrors a legacy Funnel Builder snapshot. Legacy IDs remain in
   * config for traceability while canonical IDs stay stable across updates.
   */
  reconcileLegacySnapshot(
    agencyId: string,
    snapshot: {
      funnel: {
        id: string;
        name: string;
        description?: string;
        type: string;
        status: string;
      };
      stages: Array<{
        id: string;
        name: string;
        description?: string;
        type: string;
        position?: number;
        row?: number;
        column?: number;
        libraryId?: string;
        items?: unknown[];
        integration?: Record<string, unknown>;
        pageLink?: Record<string, unknown>;
        kpiTracking?: Record<string, unknown>;
      }>;
      edges: Array<{
        id: string;
        sourceStageId: string;
        targetStageId: string;
        label?: string;
        conditionConfig?: Record<string, unknown>;
      }>;
    },
  ): AgencyFunnel {
    this.requireAgency(agencyId);
    const legacyId = required(snapshot.funnel.id, "legacy funnel id");
    let funnel = this.getFunnel(agencyId, legacyId);
    if (!funnel) {
      const core = this.resolveCoreFunnel(agencyId);
      funnel = this.createFunnel(agencyId, {
        id: `agency-funnel:${legacyId}`,
        legacyFunnelId: legacyId,
        parentFunnelId: core?.id,
        name: snapshot.funnel.name,
        description: snapshot.funnel.description,
        kind: this.legacyKind(snapshot.funnel.type),
        objective: snapshot.funnel.description || `Operate ${snapshot.funnel.name}.`,
      });
    }
    const canonicalStatus: AgencyFunnelStatus =
      snapshot.funnel.status === "active"
        ? "live"
        : snapshot.funnel.status === "paused"
          ? "paused"
          : snapshot.funnel.status === "archived"
            ? "archived"
            : "draft";
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE agency_funnels SET name=?,description=?,kind=?,status=?,objective=?,updated_at=?
        WHERE agency_id=? AND id=?`)
        .run(
          required(snapshot.funnel.name, "name"),
          snapshot.funnel.description?.trim() ?? "",
          this.legacyKind(snapshot.funnel.type),
          canonicalStatus,
          snapshot.funnel.description?.trim() || `Operate ${snapshot.funnel.name}.`,
          Date.now(),
          agencyId,
          funnel!.id,
        );

      const existingNodes = this.listNodes(agencyId, funnel!.id);
      const byLegacyId = new Map(
        existingNodes
          .map(
            (node) =>
              [
                typeof node.config.legacyStageId === "string" ? node.config.legacyStageId : "",
                node,
              ] as const,
          )
          .filter(([id]) => id),
      );
      const keepNodeIds = new Set<string>();
      const nodeIdByLegacy = new Map<string, string>();
      for (const [index, stage] of snapshot.stages.entries()) {
        const nodeId = byLegacyId.get(stage.id)?.id ?? `agency-node:${legacyId}:${stage.id}`;
        keepNodeIds.add(nodeId);
        nodeIdByLegacy.set(stage.id, nodeId);
        const config = {
          legacyStageId: stage.id,
          libraryId: stage.libraryId ?? null,
          items: stage.items ?? [],
          integration: stage.integration ?? null,
          pageLink: stage.pageLink ?? null,
          kpiTracking: stage.kpiTracking ?? null,
        };
        const now = Date.now();
        this.db
          .prepare(`INSERT INTO agency_funnel_nodes
          (id,agency_id,funnel_id,node_type,name,description,config_json,position_x,position_y,sort_order,enabled,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET node_type=excluded.node_type,name=excluded.name,description=excluded.description,
          config_json=excluded.config_json,position_x=excluded.position_x,position_y=excluded.position_y,
          sort_order=excluded.sort_order,enabled=1,updated_at=excluded.updated_at`)
          .run(
            nodeId,
            agencyId,
            funnel!.id,
            this.legacyNodeType(stage.type),
            stage.name,
            stage.description ?? "",
            JSON.stringify(config),
            Number(stage.column ?? index) * 240,
            Number(stage.row ?? 0) * 160,
            stage.position ?? index,
            1,
            now,
            now,
          );
      }
      for (const node of existingNodes) {
        if (typeof node.config.legacyStageId === "string" && !keepNodeIds.has(node.id)) {
          this.db
            .prepare("DELETE FROM agency_funnel_nodes WHERE agency_id=? AND funnel_id=? AND id=?")
            .run(agencyId, funnel!.id, node.id);
        }
      }

      this.db
        .prepare("DELETE FROM agency_funnel_edges WHERE agency_id=? AND funnel_id=?")
        .run(agencyId, funnel!.id);
      for (const edge of snapshot.edges) {
        const sourceNodeId = nodeIdByLegacy.get(edge.sourceStageId);
        const targetNodeId = nodeIdByLegacy.get(edge.targetStageId);
        if (!sourceNodeId || !targetNodeId) continue;
        const now = Date.now();
        this.db
          .prepare(`INSERT INTO agency_funnel_edges
          (id,agency_id,funnel_id,source_node_id,target_node_id,label,condition_json,priority,enabled,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            `agency-edge:${legacyId}:${edge.id}`,
            agencyId,
            funnel!.id,
            sourceNodeId,
            targetNodeId,
            edge.label?.trim() || null,
            JSON.stringify({ ...edge.conditionConfig, legacyConnectionId: edge.id }),
            0,
            1,
            now,
            now,
          );
      }
    })();
    return this.mustFunnel(agencyId, funnel.id);
  }

  archiveLegacyFunnel(agencyId: string, legacyFunnelId: string): boolean {
    const funnel = this.getFunnel(agencyId, legacyFunnelId);
    if (!funnel) return false;
    this.db
      .prepare(
        "UPDATE agency_funnels SET status='archived',updated_at=? WHERE agency_id=? AND id=?",
      )
      .run(Date.now(), agencyId, funnel.id);
    return true;
  }

  createNode(
    agencyId: string,
    funnelId: string,
    input: {
      id?: string;
      nodeType: AgencyFunnelNodeType;
      name: string;
      description?: string;
      config?: Record<string, unknown>;
      positionX?: number;
      positionY?: number;
      sortOrder?: number;
      enabled?: boolean;
    },
  ): AgencyFunnelNode {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const now = Date.now();
    const node: AgencyFunnelNode = {
      id: input.id?.trim() || randomUUID(),
      agencyId,
      funnelId: funnel.id,
      nodeType: input.nodeType,
      name: required(input.name, "name"),
      description: input.description?.trim() ?? "",
      config: input.config ?? {},
      positionX: input.positionX ?? 0,
      positionY: input.positionY ?? 0,
      sortOrder: input.sortOrder ?? 0,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO agency_funnel_nodes
      (id,agency_id,funnel_id,node_type,name,description,config_json,position_x,position_y,sort_order,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        node.id,
        agencyId,
        funnel.id,
        node.nodeType,
        node.name,
        node.description,
        JSON.stringify(node.config),
        node.positionX,
        node.positionY,
        node.sortOrder,
        node.enabled ? 1 : 0,
        now,
        now,
      );
    return node;
  }

  listNodes(agencyId: string, funnelId: string): AgencyFunnelNode[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    return (
      this.db
        .prepare(
          "SELECT * FROM agency_funnel_nodes WHERE agency_id=? AND funnel_id=? ORDER BY sort_order,id",
        )
        .all(agencyId, funnel.id) as Row[]
    ).map(this.mapNode);
  }

  createEdge(
    agencyId: string,
    funnelId: string,
    input: {
      sourceNodeId: string;
      targetNodeId: string;
      label?: string;
      condition?: Record<string, unknown>;
      priority?: number;
      enabled?: boolean;
    },
  ): AgencyFunnelEdge {
    const funnel = this.mustFunnel(agencyId, funnelId);
    if (input.sourceNodeId === input.targetNodeId)
      throw new Error("self-referencing edge not allowed");
    for (const nodeId of [input.sourceNodeId, input.targetNodeId]) {
      const node = this.db
        .prepare("SELECT id FROM agency_funnel_nodes WHERE agency_id=? AND funnel_id=? AND id=?")
        .get(agencyId, funnel.id, nodeId);
      if (!node) throw new Error("edge node not found in funnel");
    }
    const now = Date.now();
    const edge: AgencyFunnelEdge = {
      id: randomUUID(),
      agencyId,
      funnelId: funnel.id,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      label: input.label?.trim() || null,
      condition: input.condition ?? {},
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO agency_funnel_edges
      (id,agency_id,funnel_id,source_node_id,target_node_id,label,condition_json,priority,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        edge.id,
        agencyId,
        funnel.id,
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.label,
        JSON.stringify(edge.condition),
        edge.priority,
        edge.enabled ? 1 : 0,
        now,
        now,
      );
    return edge;
  }

  listEdges(agencyId: string, funnelId: string): AgencyFunnelEdge[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    return (
      this.db
        .prepare(
          "SELECT * FROM agency_funnel_edges WHERE agency_id=? AND funnel_id=? ORDER BY priority,id",
        )
        .all(agencyId, funnel.id) as Row[]
    ).map(this.mapEdge);
  }

  upsertConnection(
    agencyId: string,
    funnelId: string,
    input: {
      id?: string;
      nodeId?: string;
      provider: string;
      connectionKey: string;
      status?: FunnelConnectionStatus;
      config?: Record<string, unknown>;
      lastError?: string;
    },
  ): AgencyFunnelConnection {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const existing = this.db
      .prepare("SELECT * FROM agency_funnel_connections WHERE agency_id=? AND connection_key=?")
      .get(agencyId, input.connectionKey) as Row | undefined;
    const now = Date.now();
    const connection: AgencyFunnelConnection = {
      id: existing ? String(existing.id) : input.id?.trim() || randomUUID(),
      agencyId,
      funnelId: funnel.id,
      nodeId: input.nodeId ?? (existing?.node_id as string | null) ?? null,
      provider: required(input.provider, "provider"),
      connectionKey: required(input.connectionKey, "connectionKey"),
      status: input.status ?? "disconnected",
      config: input.config ?? {},
      lastCheckedAt: (existing?.last_checked_at as number | null) ?? null,
      lastHealthyAt: (existing?.last_healthy_at as number | null) ?? null,
      lastError: input.lastError?.trim() || null,
      createdAt: existing ? Number(existing.created_at) : now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO agency_funnel_connections
      (id,agency_id,funnel_id,node_id,provider,connection_key,status,config_json,last_checked_at,last_healthy_at,last_error,created_at,updated_at)
      VALUES (@id,@agencyId,@funnelId,@nodeId,@provider,@connectionKey,@status,@configJson,@lastCheckedAt,@lastHealthyAt,@lastError,@createdAt,@updatedAt)
      ON CONFLICT(agency_id,connection_key) DO UPDATE SET node_id=excluded.node_id,provider=excluded.provider,status=excluded.status,
      config_json=excluded.config_json,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .run({ ...connection, configJson: JSON.stringify(connection.config) });
    return connection;
  }

  listConnections(agencyId: string, funnelId: string): AgencyFunnelConnection[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    return (
      this.db
        .prepare(
          "SELECT * FROM agency_funnel_connections WHERE agency_id=? AND funnel_id=? ORDER BY provider",
        )
        .all(agencyId, funnel.id) as Row[]
    ).map(this.mapConnection);
  }

  createRequirement(
    agencyId: string,
    funnelId: string,
    input: {
      nodeId?: string;
      connectionId?: string;
      kind: SetupRequirementKind;
      name: string;
      description?: string;
      required?: boolean;
      status?: SetupRequirementStatus;
      evidence?: Record<string, unknown>;
    },
  ): AgencyFunnelRequirement {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const now = Date.now();
    const requirement: AgencyFunnelRequirement = {
      id: randomUUID(),
      agencyId,
      funnelId: funnel.id,
      nodeId: input.nodeId ?? null,
      connectionId: input.connectionId ?? null,
      kind: input.kind,
      name: required(input.name, "name"),
      description: input.description?.trim() ?? "",
      required: input.required ?? true,
      status: input.status ?? "missing",
      evidence: input.evidence ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO agency_funnel_requirements
      (id,agency_id,funnel_id,node_id,connection_id,kind,name,description,required,status,evidence_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        requirement.id,
        agencyId,
        funnel.id,
        requirement.nodeId,
        requirement.connectionId,
        requirement.kind,
        requirement.name,
        requirement.description,
        requirement.required ? 1 : 0,
        requirement.status,
        JSON.stringify(requirement.evidence),
        now,
        now,
      );
    return requirement;
  }

  setRequirementStatus(
    agencyId: string,
    requirementId: string,
    status: SetupRequirementStatus,
    evidence?: Record<string, unknown>,
  ): AgencyFunnelRequirement {
    const result = this.db
      .prepare(
        "UPDATE agency_funnel_requirements SET status=?,evidence_json=?,updated_at=? WHERE agency_id=? AND id=?",
      )
      .run(status, JSON.stringify(evidence ?? {}), Date.now(), agencyId, requirementId);
    if (!result.changes) throw new Error("requirement not found");
    return this.mapRequirement(
      this.db
        .prepare("SELECT * FROM agency_funnel_requirements WHERE agency_id=? AND id=?")
        .get(agencyId, requirementId) as Row,
    );
  }

  listRequirements(agencyId: string, funnelId: string): AgencyFunnelRequirement[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    return (
      this.db
        .prepare(
          "SELECT * FROM agency_funnel_requirements WHERE agency_id=? AND funnel_id=? ORDER BY required DESC,name",
        )
        .all(agencyId, funnel.id) as Row[]
    ).map(this.mapRequirement);
  }

  recordHealthCheck(
    agencyId: string,
    funnelId: string,
    input: {
      targetType: AgencyFunnelHealthCheck["targetType"];
      targetId: string;
      status: FunnelHealthStatus;
      message?: string;
      latencyMs?: number;
      details?: Record<string, unknown>;
      checkedAt?: number;
    },
  ): AgencyFunnelHealthCheck {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const check: AgencyFunnelHealthCheck = {
      id: randomUUID(),
      agencyId,
      funnelId: funnel.id,
      targetType: input.targetType,
      targetId: input.targetId,
      status: input.status,
      message: input.message?.trim() || null,
      latencyMs: input.latencyMs ?? null,
      details: input.details ?? {},
      checkedAt: input.checkedAt ?? Date.now(),
    };
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO agency_funnel_health_checks VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          check.id,
          agencyId,
          funnel.id,
          check.targetType,
          check.targetId,
          check.status,
          check.message,
          check.latencyMs,
          JSON.stringify(check.details),
          check.checkedAt,
        );
      if (check.targetType === "connection") {
        const connectionStatus =
          check.status === "healthy"
            ? "connected"
            : check.status === "degraded"
              ? "degraded"
              : "error";
        this.db
          .prepare(`UPDATE agency_funnel_connections SET status=?,last_checked_at=?,
          last_healthy_at=CASE WHEN ?='healthy' THEN ? ELSE last_healthy_at END,last_error=?,updated_at=?
          WHERE agency_id=? AND id=?`)
          .run(
            connectionStatus,
            check.checkedAt,
            check.status,
            check.checkedAt,
            check.status === "healthy" ? null : check.message,
            Date.now(),
            agencyId,
            check.targetId,
          );
      }
    })();
    return check;
  }

  listLatestHealth(agencyId: string, funnelId: string): AgencyFunnelHealthCheck[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const rows = this.db
      .prepare(`SELECT h.* FROM agency_funnel_health_checks h
      JOIN (SELECT target_type,target_id,MAX(checked_at) checked_at FROM agency_funnel_health_checks
        WHERE agency_id=? AND funnel_id=? GROUP BY target_type,target_id) latest
      ON latest.target_type=h.target_type AND latest.target_id=h.target_id AND latest.checked_at=h.checked_at
      WHERE h.agency_id=? AND h.funnel_id=? ORDER BY h.target_type,h.target_id`)
      .all(agencyId, funnel.id, agencyId, funnel.id) as Row[];
    return rows.map(this.mapHealth);
  }

  defineKpi(
    agencyId: string,
    funnelId: string,
    input: {
      nodeId?: string;
      key: string;
      name: string;
      unit: AgencyFunnelKpiDefinition["unit"];
      aggregation?: AgencyFunnelKpiDefinition["aggregation"];
      direction?: AgencyFunnelKpiDefinition["direction"];
      targetValue?: number;
      warningValue?: number;
      windowSeconds?: number;
    },
  ): AgencyFunnelKpiDefinition {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const now = Date.now();
    const kpi: AgencyFunnelKpiDefinition = {
      id: randomUUID(),
      agencyId,
      funnelId: funnel.id,
      nodeId: input.nodeId ?? null,
      key: required(input.key, "key"),
      name: required(input.name, "name"),
      unit: input.unit,
      aggregation: input.aggregation ?? "latest",
      direction: input.direction ?? "higher_is_better",
      targetValue: input.targetValue ?? null,
      warningValue: input.warningValue ?? null,
      windowSeconds: input.windowSeconds ?? 86400,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO agency_funnel_kpis VALUES (@id,@agencyId,@funnelId,@nodeId,@key,@name,@unit,@aggregation,@direction,@targetValue,@warningValue,@windowSeconds,@createdAt,@updatedAt)",
      )
      .run(kpi);
    return kpi;
  }

  recordKpi(
    agencyId: string,
    kpiId: string,
    value: number,
    input?: { dimensions?: Record<string, string>; recordedAt?: number },
  ): AgencyFunnelKpiReading {
    if (!Number.isFinite(value)) throw new Error("value must be finite");
    const kpi = this.db
      .prepare("SELECT * FROM agency_funnel_kpis WHERE agency_id=? AND id=?")
      .get(agencyId, kpiId) as Row | undefined;
    if (!kpi) throw new Error("KPI not found");
    const reading: AgencyFunnelKpiReading = {
      id: randomUUID(),
      agencyId,
      funnelId: String(kpi.funnel_id),
      kpiId,
      value,
      dimensions: input?.dimensions ?? {},
      recordedAt: input?.recordedAt ?? Date.now(),
    };
    this.db
      .prepare("INSERT INTO agency_funnel_kpi_readings VALUES (?,?,?,?,?,?,?)")
      .run(
        reading.id,
        agencyId,
        reading.funnelId,
        kpiId,
        value,
        JSON.stringify(reading.dimensions),
        reading.recordedAt,
      );
    return reading;
  }

  listKpis(agencyId: string, funnelId: string): AgencyFunnelKpiDefinition[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    return (
      this.db
        .prepare("SELECT * FROM agency_funnel_kpis WHERE agency_id=? AND funnel_id=? ORDER BY key")
        .all(agencyId, funnel.id) as Row[]
    ).map(this.mapKpi);
  }

  detectGaps(agencyId: string, funnelId: string, now = Date.now()): AgencyFunnelGap[] {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const nodes = this.listNodes(agencyId, funnel.id).filter((node) => node.enabled);
    const edges = this.listEdges(agencyId, funnel.id).filter((edge) => edge.enabled);
    const requirements = this.listRequirements(agencyId, funnel.id);
    const connections = this.listConnections(agencyId, funnel.id);
    const kpis = this.listKpis(agencyId, funnel.id);
    const gaps: AgencyFunnelGap[] = [];
    const add = (gap: AgencyFunnelGap) => gaps.push(gap);
    if (!nodes.some((node) => node.nodeType === "source"))
      add({
        code: "missing_source",
        severity: "critical",
        entityType: "funnel",
        entityId: funnel.id,
        message: "Funnel has no enabled source node.",
        recommendedAction: "Add and configure a source node.",
      });
    if (!nodes.some((node) => node.nodeType === "exit"))
      add({
        code: "missing_exit",
        severity: "critical",
        entityType: "funnel",
        entityId: funnel.id,
        message: "Funnel has no enabled exit node.",
        recommendedAction: "Add an explicit success or failure exit.",
      });
    const connectedNodeIds = new Set(
      edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
    );
    for (const node of nodes.filter((node) => nodes.length > 1 && !connectedNodeIds.has(node.id))) {
      add({
        code: "disconnected_node",
        severity: "critical",
        entityType: "node",
        entityId: node.id,
        message: `${node.name} is disconnected.`,
        recommendedAction: "Connect this node to the operating path.",
      });
    }
    for (const requirement of requirements.filter(
      (r) => r.required && !["satisfied", "waived"].includes(r.status),
    )) {
      add({
        code: "setup_incomplete",
        severity: "critical",
        entityType: "requirement",
        entityId: requirement.id,
        message: `Required setup incomplete: ${requirement.name}.`,
        recommendedAction: "Complete the requirement and attach evidence.",
      });
    }
    for (const connection of connections.filter((c) => c.status !== "connected")) {
      add({
        code: "connection_unhealthy",
        severity: connection.status === "degraded" ? "warning" : "critical",
        entityType: "connection",
        entityId: connection.id,
        message: `${connection.provider} is ${connection.status}.`,
        recommendedAction: "Repair and health-check the connection.",
      });
    }
    for (const kpi of kpis) {
      const latest = this.latestReading(agencyId, kpi.id);
      if (!latest || now - latest.recordedAt > kpi.windowSeconds * 2000) {
        add({
          code: "kpi_stale",
          severity: "warning",
          entityType: "kpi",
          entityId: kpi.id,
          message: `${kpi.name} has no recent reading.`,
          recommendedAction: "Verify instrumentation and ingest a current KPI reading.",
        });
      } else if (this.kpiState(kpi, latest) === "critical") {
        add({
          code: "kpi_off_target",
          severity: "warning",
          entityType: "kpi",
          entityId: kpi.id,
          message: `${kpi.name} is outside its operating threshold.`,
          recommendedAction: "Investigate the responsible stage and assign corrective work.",
        });
      }
    }
    return gaps;
  }

  getOperatingContext(agencyId: string, funnelId: string): AgencyFunnelOperatingContext {
    const funnel = this.mustFunnel(agencyId, funnelId);
    const requirements = this.listRequirements(agencyId, funnel.id);
    const connections = this.listConnections(agencyId, funnel.id);
    const checks = this.listLatestHealth(agencyId, funnel.id);
    const gaps = this.detectGaps(agencyId, funnel.id);
    const kpis = this.listKpis(agencyId, funnel.id).map((kpi) => {
      const latest = this.latestReading(agencyId, kpi.id);
      return { ...kpi, latest, state: this.kpiState(kpi, latest) };
    });
    const healthRank: Record<FunnelHealthStatus, number> = {
      unknown: 0,
      healthy: 1,
      degraded: 2,
      unhealthy: 3,
    };
    const health = checks.reduce<FunnelHealthStatus>(
      (worst, check) => (healthRank[check.status] > healthRank[worst] ? check.status : worst),
      checks.length ? "healthy" : "unknown",
    );
    const requiredRequirements = requirements.filter((r) => r.required);
    const satisfied = requiredRequirements.filter((r) =>
      ["satisfied", "waived"].includes(r.status),
    ).length;
    return {
      generatedAt: Date.now(),
      agencyId,
      funnel,
      subFunnels: this.listFunnels(agencyId, { parentFunnelId: funnel.id }),
      graph: {
        nodes: this.listNodes(agencyId, funnel.id),
        edges: this.listEdges(agencyId, funnel.id),
      },
      setup: {
        ready: !gaps.some((g) => g.severity === "critical"),
        required: requiredRequirements.length,
        satisfied,
        requirements,
        connections,
      },
      health: { status: health, checks },
      kpis,
      gaps,
      recommendedActions: [...new Set(gaps.map((gap) => gap.recommendedAction))],
    };
  }

  getOverview(agencyId: string, funnelId?: string): AgencyFunnelOverview {
    const selected = this.resolveCoreFunnel(agencyId, funnelId);
    if (!selected) {
      return {
        coreFunnel: null,
        subFunnels: [],
        nodes: [],
        edges: [],
        connections: [],
        kpis: [],
        gaps: [
          {
            id: "funnel_missing:agency",
            severity: "critical",
            title: "Core funnel not configured",
            description: "This agency does not have a core operating funnel yet.",
            recommendedAction: "Create the agency core funnel and complete its setup map.",
            ownerWorkerId: null,
          },
        ],
        healthStatus: "unknown",
        healthScore: 0,
        setupPercent: 0,
      };
    }
    const context = this.getOperatingContext(agencyId, selected.id);
    const requiredConnectionIds = new Set(
      context.setup.requirements
        .filter((requirement) => requirement.required && requirement.connectionId)
        .map((requirement) => requirement.connectionId),
    );
    const latestCheckByTarget = new Map(
      context.health.checks.map((check) => [`${check.targetType}:${check.targetId}`, check]),
    );
    const severityTitle: Record<AgencyFunnelGap["severity"], string> = {
      critical: "Critical operating gap",
      warning: "Performance warning",
      info: "Optimization opportunity",
    };
    const healthyChecks = context.health.checks.filter(
      (check) => check.status === "healthy",
    ).length;
    const healthScore = context.health.checks.length
      ? Math.round((healthyChecks / context.health.checks.length) * 100)
      : context.setup.ready
        ? 100
        : 0;
    return {
      coreFunnel: context.funnel,
      subFunnels: context.subFunnels,
      nodes: context.graph.nodes,
      edges: context.graph.edges,
      connections: context.setup.connections.map((connection) => ({
        id: connection.id,
        name: connection.provider,
        kind: connection.connectionKey,
        status: connection.status,
        required: requiredConnectionIds.has(connection.id),
        lastCheckedAt: connection.lastCheckedAt,
        message:
          connection.lastError ??
          latestCheckByTarget.get(`connection:${connection.id}`)?.message ??
          null,
      })),
      kpis: context.kpis.map((kpi) => ({
        id: kpi.id,
        name: kpi.name,
        value: kpi.latest?.value ?? null,
        target: kpi.targetValue,
        unit: kpi.unit,
        status: kpi.state,
      })),
      gaps: context.gaps.map((gap) => ({
        id: `${gap.code}:${gap.entityId}`,
        severity: gap.severity,
        title: severityTitle[gap.severity],
        description: gap.message,
        recommendedAction: gap.recommendedAction,
        ownerWorkerId: context.funnel.ownerId,
      })),
      healthStatus: context.health.status,
      healthScore,
      setupPercent: context.setup.required
        ? Math.round((context.setup.satisfied / context.setup.required) * 100)
        : context.setup.ready
          ? 100
          : 0,
    };
  }

  resolveCoreFunnel(agencyId: string, funnelId?: string): AgencyFunnel | null {
    if (funnelId) return this.getFunnel(agencyId, funnelId);
    this.requireAgency(agencyId);
    const row = this.db
      .prepare(`SELECT * FROM agency_funnels
      WHERE agency_id=? AND parent_funnel_id IS NULL AND status!='archived'
      ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'degraded' THEN 1 WHEN 'ready' THEN 2
        WHEN 'setup' THEN 3 WHEN 'draft' THEN 4 WHEN 'paused' THEN 5 ELSE 6 END, updated_at DESC
      LIMIT 1`)
      .get(agencyId) as Row | undefined;
    return row ? this.mapFunnel(row) : null;
  }

  getCoreOperatingContext(
    agencyId: string,
    funnelId?: string,
  ): AgencyFunnelOperatingContext | null {
    const selected = this.resolveCoreFunnel(agencyId, funnelId);
    return selected ? this.getOperatingContext(agencyId, selected.id) : null;
  }

  private latestReading(agencyId: string, kpiId: string): AgencyFunnelKpiReading | null {
    const row = this.db
      .prepare(
        "SELECT * FROM agency_funnel_kpi_readings WHERE agency_id=? AND kpi_id=? ORDER BY recorded_at DESC LIMIT 1",
      )
      .get(agencyId, kpiId) as Row | undefined;
    return row ? this.mapReading(row) : null;
  }

  private kpiState(
    kpi: AgencyFunnelKpiDefinition,
    reading: AgencyFunnelKpiReading | null,
  ): "on_target" | "warning" | "critical" | "unknown" {
    if (!reading || kpi.targetValue == null) return "unknown";
    const meets =
      kpi.direction === "higher_is_better"
        ? reading.value >= kpi.targetValue
        : reading.value <= kpi.targetValue;
    if (meets) return "on_target";
    if (kpi.warningValue == null) return "critical";
    const withinWarning =
      kpi.direction === "higher_is_better"
        ? reading.value >= kpi.warningValue
        : reading.value <= kpi.warningValue;
    return withinWarning ? "warning" : "critical";
  }

  private requireAgency(agencyId: string): void {
    if (!this.db.prepare("SELECT id FROM agencies WHERE id=?").get(required(agencyId, "agencyId")))
      throw new Error("agency not found");
  }

  private legacyKind(type: string): AgencyFunnelKind {
    if (type === "onboarding") return "client_onboarding";
    if (type === "recruitment") return "recruitment";
    if (type === "sales") return "sales";
    if (type === "marketing") return "lead_generation";
    if (type === "support") return "retention";
    return "custom";
  }

  private legacyNodeType(type: string): AgencyFunnelNodeType {
    if (type === "entry") return "source";
    if (type === "decision") return "decision";
    if (type === "exit") return "exit";
    return "action";
  }

  private mustFunnel(agencyId: string, id: string): AgencyFunnel {
    const funnel = this.getFunnel(agencyId, id);
    if (!funnel) throw new Error("funnel not found");
    return funnel;
  }

  private mapFunnel = (row: Row): AgencyFunnel => camel(row);
  private mapNode = (row: Row): AgencyFunnelNode => ({
    ...camel(row),
    enabled: Boolean(row.enabled),
    config: parseJson(row.config_json),
  });
  private mapEdge = (row: Row): AgencyFunnelEdge => ({
    ...camel(row),
    enabled: Boolean(row.enabled),
    condition: parseJson(row.condition_json),
  });
  private mapConnection = (row: Row): AgencyFunnelConnection => ({
    ...camel(row),
    config: parseJson(row.config_json),
  });
  private mapRequirement = (row: Row): AgencyFunnelRequirement => ({
    ...camel(row),
    required: Boolean(row.required),
    evidence: parseJson(row.evidence_json),
  });
  private mapHealth = (row: Row): AgencyFunnelHealthCheck => ({
    ...camel(row),
    details: parseJson(row.details_json),
  });
  private mapKpi = (row: Row): AgencyFunnelKpiDefinition => camel(row);
  private mapReading = (row: Row): AgencyFunnelKpiReading => ({
    ...camel(row),
    dimensions: parseJson(row.dimensions_json),
  });
}

const stores = new Map<string, AgencyFunnelStore>();

export function getAgencyFunnelStore(
  stateDirOrDbPath: string,
  options?: { isDatabasePath?: boolean },
): AgencyFunnelStore {
  const dbPath = options?.isDatabasePath
    ? stateDirOrDbPath
    : join(stateDirOrDbPath, "agency-operations", "agency.db");
  const existing = stores.get(dbPath);
  if (existing) return existing;
  const store = new AgencyFunnelStore(dbPath);
  stores.set(dbPath, store);
  return store;
}

export function resetAgencyFunnelStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}

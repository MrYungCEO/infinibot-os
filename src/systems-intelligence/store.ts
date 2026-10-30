/**
 * Systems Intelligence Store — SQLite-backed storage for system data.
 *
 * Tables: values, priorities, outcomes, system_nodes, relationships, reviews
 * Database: state/systems-intelligence.db
 */

import { mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  Value,
  ValueCreateParams,
  ValueUpdateParams,
  ValueListParams,
  Goal,
  GoalCreateParams,
  GoalUpdateParams,
  GoalListParams,
  Priority,
  PriorityCreateParams,
  PriorityUpdateParams,
  PriorityListParams,
  SystemNode,
  SystemNodeCreateParams,
  SystemNodeUpdateParams,
  SystemNodeListParams,
  Relationship,
  RelationshipCreateParams,
  RelationshipUpdateParams,
  RelationshipListParams,
  Review,
  ReviewCreateParams,
  ReviewListParams,
  SystemGraph,
} from "./types.js";

const log = createSubsystemLogger("systems-intelligence");

export class SystemsIntelligenceStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "systems-intelligence.db");

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.createTables();
    this.runMigrations();
    log.info("Systems Intelligence store initialized", { dbPath });
  }

  private runMigrations(): void {
    // Add category and weight columns if they don't exist
    const columns = this.db.prepare('PRAGMA table_info("values")').all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);

    if (!columnNames.includes("category")) {
      this.db.exec("ALTER TABLE \"values\" ADD COLUMN category TEXT NOT NULL DEFAULT 'core'");
      log.info("Added category column to values table");
    }
    if (!columnNames.includes("weight")) {
      this.db.exec('ALTER TABLE "values" ADD COLUMN weight INTEGER NOT NULL DEFAULT 5');
      log.info("Added weight column to values table");
    }

    // Add goalIds column to priorities if it doesn't exist
    const priorityColumns = this.db.prepare("PRAGMA table_info(priorities)").all() as {
      name: string;
    }[];
    const priorityColumnNames = priorityColumns.map((c) => c.name);

    if (!priorityColumnNames.includes("goalIds")) {
      this.db.exec("ALTER TABLE priorities ADD COLUMN goalIds TEXT NOT NULL DEFAULT '[]'");
      log.info("Added goalIds column to priorities table");
    }
  }

  private createTables(): void {
    this.db.exec(`
      -- Values table
      CREATE TABLE IF NOT EXISTS "values" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        indicators TEXT NOT NULL,
        color TEXT NOT NULL,
        "order" INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'core',
        weight INTEGER NOT NULL DEFAULT 5,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      -- Priorities table
      CREATE TABLE IF NOT EXISTS priorities (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        quarter TEXT NOT NULL,
        rank INTEGER NOT NULL,
        valueIds TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      -- Goals table
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        timeframe TEXT NOT NULL DEFAULT 'medium',
        targetDate INTEGER,
        valueIds TEXT NOT NULL DEFAULT '[]',
        milestones TEXT NOT NULL DEFAULT '[]',
        progress REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        color TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_goals_timeframe ON goals(timeframe);

      -- Outcomes table (linked to priorities)
      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY,
        priorityId TEXT NOT NULL,
        description TEXT NOT NULL,
        targetDate INTEGER,
        completed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (priorityId) REFERENCES priorities(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_priorityId ON outcomes(priorityId);

      -- System nodes table
      CREATE TABLE IF NOT EXISTS system_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        notionId TEXT,
        kanbanProjectId TEXT,
        valueIds TEXT,
        priorityIds TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        x REAL,
        y REAL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_system_nodes_type ON system_nodes(type);

      -- Relationships table
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1,
        label TEXT,
        notes TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (sourceId) REFERENCES system_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (targetId) REFERENCES system_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_relationships_sourceId ON relationships(sourceId);
      CREATE INDEX IF NOT EXISTS idx_relationships_targetId ON relationships(targetId);
      CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);

      -- Reviews table
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        date INTEGER NOT NULL,
        priorityProgress TEXT NOT NULL,
        reflections TEXT NOT NULL,
        wins TEXT NOT NULL,
        challenges TEXT NOT NULL,
        nextActions TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_type ON reviews(type);
      CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(date);
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  // VALUES CRUD
  // ═══════════════════════════════════════════════════════════════

  listValues(params?: ValueListParams): Value[] {
    let sql = 'SELECT * FROM "values" ORDER BY "order" ASC';
    if (params?.limit) sql += ` LIMIT ${params.limit}`;

    const rows = this.db.prepare(sql).all() as any[];
    return rows.map((row) => this.rowToValue(row));
  }

  getValue(id: string): Value | null {
    const row = this.db.prepare('SELECT * FROM "values" WHERE id = ?').get(id);
    return row ? this.rowToValue(row as any) : null;
  }

  createValue(params: ValueCreateParams): Value {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO "values" (id, name, description, indicators, color, "order", category, weight, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        params.name,
        params.description,
        JSON.stringify(params.indicators),
        params.color,
        params.order,
        (params as any).category || "core",
        (params as any).weight ?? 5,
        now,
        now,
      );

    return this.getValue(id)!;
  }

  updateValue(params: ValueUpdateParams): Value | null {
    const existing = this.getValue(params.id);
    if (!existing) return null;

    const now = Date.now();
    const updated = {
      name: params.name ?? existing.name,
      description: params.description ?? existing.description,
      indicators: params.indicators ?? existing.indicators,
      color: params.color ?? existing.color,
      order: params.order ?? existing.order,
    };

    this.db
      .prepare(`
      UPDATE "values" SET name = ?, description = ?, indicators = ?, color = ?, "order" = ?, updatedAt = ?
      WHERE id = ?
    `)
      .run(
        updated.name,
        updated.description,
        JSON.stringify(updated.indicators),
        updated.color,
        updated.order,
        now,
        params.id,
      );

    return this.getValue(params.id);
  }

  deleteValue(id: string): boolean {
    const result = this.db.prepare('DELETE FROM "values" WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private rowToValue(row: any): Value {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      indicators: JSON.parse(row.indicators || "[]"),
      color: row.color,
      order: row.order,
      category: row.category || "core",
      weight: row.weight ?? 5,
      linkedPriorities: [], // Computed field, not stored
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as any;
  }

  // ═══════════════════════════════════════════════════════════════
  // GOALS CRUD
  // ═══════════════════════════════════════════════════════════════

  listGoals(params?: GoalListParams): Goal[] {
    let sql = "SELECT * FROM goals";
    const conditions: string[] = [];
    const values: any[] = [];

    if (params?.timeframe) {
      conditions.push("timeframe = ?");
      values.push(params.timeframe);
    }
    if (params?.status) {
      conditions.push("status = ?");
      values.push(params.status);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY createdAt DESC";
    if (params?.limit) sql += ` LIMIT ${params.limit}`;

    const stmt = this.db.prepare(sql);
    const rows = values.length > 0 ? stmt.all(...values) : stmt.all();
    return (rows as any[]).map((row) => this.rowToGoal(row));
  }

  getGoal(id: string): Goal | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
    return row ? this.rowToGoal(row as any) : null;
  }

  createGoal(params: GoalCreateParams): Goal {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO goals (id, title, description, timeframe, targetDate, valueIds, milestones, progress, status, color, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        params.title,
        params.description || null,
        params.timeframe,
        params.targetDate || null,
        JSON.stringify(params.valueIds || []),
        JSON.stringify(params.milestones || []),
        params.progress || 0,
        params.status || "active",
        params.color || null,
        now,
        now,
      );

    log.info("Created goal", { id, title: params.title });
    return this.getGoal(id)!;
  }

  updateGoal(params: GoalUpdateParams): Goal | null {
    const existing = this.getGoal(params.id);
    if (!existing) return null;

    const now = Date.now();
    const updated = {
      title: params.title ?? existing.title,
      description: params.description ?? existing.description,
      timeframe: params.timeframe ?? existing.timeframe,
      targetDate: params.targetDate ?? existing.targetDate,
      valueIds: params.valueIds ?? existing.valueIds,
      milestones: params.milestones ?? existing.milestones,
      progress: params.progress ?? existing.progress,
      status: params.status ?? existing.status,
      color: params.color ?? existing.color,
    };

    this.db
      .prepare(`
      UPDATE goals SET title = ?, description = ?, timeframe = ?, targetDate = ?, valueIds = ?, milestones = ?, progress = ?, status = ?, color = ?, updatedAt = ?
      WHERE id = ?
    `)
      .run(
        updated.title,
        updated.description,
        updated.timeframe,
        updated.targetDate,
        JSON.stringify(updated.valueIds),
        JSON.stringify(updated.milestones),
        updated.progress,
        updated.status,
        updated.color,
        now,
        params.id,
      );

    return this.getGoal(params.id);
  }

  deleteGoal(id: string): boolean {
    const result = this.db.prepare("DELETE FROM goals WHERE id = ?").run(id);
    log.info("Deleted goal", { id, deleted: result.changes > 0 });
    return result.changes > 0;
  }

  private rowToGoal(row: any): Goal {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      timeframe: row.timeframe,
      targetDate: row.targetDate,
      valueIds: JSON.parse(row.valueIds || "[]"),
      milestones: JSON.parse(row.milestones || "[]"),
      progress: row.progress,
      status: row.status,
      color: row.color,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIORITIES CRUD
  // ═══════════════════════════════════════════════════════════════

  listPriorities(params?: PriorityListParams): Priority[] {
    let sql = "SELECT * FROM priorities";
    const conditions: string[] = [];
    const values: any[] = [];

    if (params?.quarter) {
      conditions.push("quarter = ?");
      values.push(params.quarter);
    }
    if (params?.status) {
      conditions.push("status = ?");
      values.push(params.status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY rank ASC";
    if (params?.limit) sql += ` LIMIT ${params.limit}`;

    const rows = this.db.prepare(sql).all(...values) as any[];
    return rows.map((row) => this.rowToPriority(row));
  }

  getPriority(id: string): Priority | null {
    const row = this.db.prepare("SELECT * FROM priorities WHERE id = ?").get(id);
    return row ? this.rowToPriority(row as any) : null;
  }

  createPriority(params: PriorityCreateParams): Priority {
    const id = crypto.randomUUID();
    const now = Date.now();

    const insertPriority = this.db.prepare(`
      INSERT INTO priorities (id, title, description, quarter, rank, valueIds, progress, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertOutcome = this.db.prepare(`
      INSERT INTO outcomes (id, priorityId, description, targetDate, completed)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      insertPriority.run(
        id,
        params.title,
        params.description ?? null,
        params.quarter,
        params.rank,
        JSON.stringify(params.valueIds),
        params.progress,
        params.status,
        now,
        now,
      );

      for (const outcome of params.outcomes) {
        insertOutcome.run(
          outcome.id || crypto.randomUUID(),
          id,
          outcome.description,
          outcome.targetDate ?? null,
          outcome.completed ? 1 : 0,
        );
      }
    });

    transaction();
    return this.getPriority(id)!;
  }

  updatePriority(params: PriorityUpdateParams): Priority | null {
    const existing = this.getPriority(params.id);
    if (!existing) return null;

    const now = Date.now();
    const updated = {
      title: params.title ?? existing.title,
      description: params.description ?? existing.description,
      quarter: params.quarter ?? existing.quarter,
      rank: params.rank ?? existing.rank,
      valueIds: params.valueIds ?? existing.valueIds,
      progress: params.progress ?? existing.progress,
      status: params.status ?? existing.status,
    };

    const updatePriority = this.db.prepare(`
      UPDATE priorities SET title = ?, description = ?, quarter = ?, rank = ?, valueIds = ?, progress = ?, status = ?, updatedAt = ?
      WHERE id = ?
    `);

    const deleteOutcomes = this.db.prepare("DELETE FROM outcomes WHERE priorityId = ?");
    const insertOutcome = this.db.prepare(`
      INSERT INTO outcomes (id, priorityId, description, targetDate, completed)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      updatePriority.run(
        updated.title,
        updated.description ?? null,
        updated.quarter,
        updated.rank,
        JSON.stringify(updated.valueIds),
        updated.progress,
        updated.status,
        now,
        params.id,
      );

      // Replace outcomes if provided
      if (params.outcomes) {
        deleteOutcomes.run(params.id);
        for (const outcome of params.outcomes) {
          insertOutcome.run(
            outcome.id || crypto.randomUUID(),
            params.id,
            outcome.description,
            outcome.targetDate ?? null,
            outcome.completed ? 1 : 0,
          );
        }
      }
    });

    transaction();
    return this.getPriority(params.id);
  }

  deletePriority(id: string): boolean {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM outcomes WHERE priorityId = ?").run(id);
      return this.db.prepare("DELETE FROM priorities WHERE id = ?").run(id);
    });
    const result = transaction();
    return result.changes > 0;
  }

  private rowToPriority(row: any): Priority {
    const outcomes = this.db
      .prepare("SELECT * FROM outcomes WHERE priorityId = ?")
      .all(row.id) as any[];
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      quarter: row.quarter,
      rank: row.rank,
      valueIds: JSON.parse(row.valueIds),
      goalIds: row.goalIds ? JSON.parse(row.goalIds) : [],
      outcomes: outcomes.map((o) => ({
        id: o.id,
        description: o.description,
        targetDate: o.targetDate ?? undefined,
        completed: o.completed === 1,
      })),
      progress: row.progress,
      status: row.status as Priority["status"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM NODES CRUD
  // ═══════════════════════════════════════════════════════════════

  listNodes(params?: SystemNodeListParams): SystemNode[] {
    let sql = "SELECT * FROM system_nodes";
    const conditions: string[] = [];
    const values: any[] = [];

    if (params?.type) {
      conditions.push("type = ?");
      values.push(params.type);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY name ASC";
    if (params?.limit) sql += ` LIMIT ${params.limit}`;

    const rows = this.db.prepare(sql).all(...values) as any[];
    return rows.map((row) => this.rowToNode(row));
  }

  getNode(id: string): SystemNode | null {
    const row = this.db.prepare("SELECT * FROM system_nodes WHERE id = ?").get(id);
    return row ? this.rowToNode(row as any) : null;
  }

  createNode(params: SystemNodeCreateParams): SystemNode {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO system_nodes (id, type, name, description, notionId, kanbanProjectId, valueIds, priorityIds, metadata, x, y, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        params.type,
        params.name,
        params.description ?? null,
        params.notionId ?? null,
        params.kanbanProjectId ?? null,
        params.valueIds ? JSON.stringify(params.valueIds) : null,
        params.priorityIds ? JSON.stringify(params.priorityIds) : null,
        JSON.stringify(params.metadata || {}),
        params.x ?? null,
        params.y ?? null,
        now,
        now,
      );

    return this.getNode(id)!;
  }

  updateNode(params: SystemNodeUpdateParams): SystemNode | null {
    const existing = this.getNode(params.id);
    if (!existing) return null;

    const now = Date.now();
    const updated = {
      type: params.type ?? existing.type,
      name: params.name ?? existing.name,
      description: params.description ?? existing.description,
      notionId: params.notionId ?? existing.notionId,
      kanbanProjectId: params.kanbanProjectId ?? existing.kanbanProjectId,
      valueIds: params.valueIds ?? existing.valueIds,
      priorityIds: params.priorityIds ?? existing.priorityIds,
      metadata: params.metadata ?? existing.metadata,
      x: params.x ?? existing.x,
      y: params.y ?? existing.y,
    };

    this.db
      .prepare(`
      UPDATE system_nodes SET type = ?, name = ?, description = ?, notionId = ?, kanbanProjectId = ?,
        valueIds = ?, priorityIds = ?, metadata = ?, x = ?, y = ?, updatedAt = ?
      WHERE id = ?
    `)
      .run(
        updated.type,
        updated.name,
        updated.description ?? null,
        updated.notionId ?? null,
        updated.kanbanProjectId ?? null,
        updated.valueIds ? JSON.stringify(updated.valueIds) : null,
        updated.priorityIds ? JSON.stringify(updated.priorityIds) : null,
        JSON.stringify(updated.metadata),
        updated.x ?? null,
        updated.y ?? null,
        now,
        params.id,
      );

    return this.getNode(params.id);
  }

  deleteNode(id: string): boolean {
    // Also delete relationships involving this node
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM relationships WHERE sourceId = ? OR targetId = ?").run(id, id);
      return this.db.prepare("DELETE FROM system_nodes WHERE id = ?").run(id);
    });
    const result = transaction();
    return result.changes > 0;
  }

  /**
   * Update just the position of a node (lightweight operation)
   */
  updateNodePosition(id: string, x: number, y: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(`
      UPDATE system_nodes SET x = ?, y = ?, updatedAt = ? WHERE id = ?
    `)
      .run(x, y, now, id);
    return result.changes > 0;
  }

  /**
   * Bulk update positions for multiple nodes
   */
  updateNodePositions(positions: Array<{ id: string; x: number; y: number }>): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE system_nodes SET x = ?, y = ?, updatedAt = ? WHERE id = ?
    `);

    let updated = 0;
    const transaction = this.db.transaction(() => {
      for (const pos of positions) {
        const result = stmt.run(pos.x, pos.y, now, pos.id);
        if (result.changes > 0) updated++;
      }
    });

    transaction();
    return updated;
  }

  private rowToNode(row: any): SystemNode {
    return {
      id: row.id,
      type: row.type as SystemNode["type"],
      name: row.name,
      description: row.description ?? undefined,
      notionId: row.notionId ?? undefined,
      kanbanProjectId: row.kanbanProjectId ?? undefined,
      valueIds: row.valueIds ? JSON.parse(row.valueIds) : undefined,
      priorityIds: row.priorityIds ? JSON.parse(row.priorityIds) : undefined,
      metadata: JSON.parse(row.metadata),
      x: row.x ?? undefined,
      y: row.y ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RELATIONSHIPS CRUD
  // ═══════════════════════════════════════════════════════════════

  listRelationships(params?: RelationshipListParams): Relationship[] {
    let sql = "SELECT * FROM relationships";
    const conditions: string[] = [];
    const values: any[] = [];

    if (params?.sourceId) {
      conditions.push("sourceId = ?");
      values.push(params.sourceId);
    }
    if (params?.targetId) {
      conditions.push("targetId = ?");
      values.push(params.targetId);
    }
    if (params?.type) {
      conditions.push("type = ?");
      values.push(params.type);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY createdAt DESC";
    if (params?.limit) sql += ` LIMIT ${params.limit}`;

    const rows = this.db.prepare(sql).all(...values) as any[];
    return rows.map((row) => this.rowToRelationship(row));
  }

  getRelationship(id: string): Relationship | null {
    const row = this.db.prepare("SELECT * FROM relationships WHERE id = ?").get(id);
    return row ? this.rowToRelationship(row as any) : null;
  }

  createRelationship(params: RelationshipCreateParams): Relationship {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO relationships (id, sourceId, targetId, type, strength, label, notes, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        params.sourceId,
        params.targetId,
        params.type,
        params.strength,
        params.label ?? null,
        params.notes ?? null,
        now,
        now,
      );

    return this.getRelationship(id)!;
  }

  updateRelationship(params: RelationshipUpdateParams): Relationship | null {
    const existing = this.getRelationship(params.id);
    if (!existing) return null;

    const now = Date.now();
    const updated = {
      sourceId: params.sourceId ?? existing.sourceId,
      targetId: params.targetId ?? existing.targetId,
      type: params.type ?? existing.type,
      strength: params.strength ?? existing.strength,
      label: params.label ?? existing.label,
      notes: params.notes ?? existing.notes,
    };

    this.db
      .prepare(`
      UPDATE relationships SET sourceId = ?, targetId = ?, type = ?, strength = ?, label = ?, notes = ?, updatedAt = ?
      WHERE id = ?
    `)
      .run(
        updated.sourceId,
        updated.targetId,
        updated.type,
        updated.strength,
        updated.label ?? null,
        updated.notes ?? null,
        now,
        params.id,
      );

    return this.getRelationship(params.id);
  }

  deleteRelationship(id: string): boolean {
    const result = this.db.prepare("DELETE FROM relationships WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private rowToRelationship(row: any): Relationship {
    return {
      id: row.id,
      sourceId: row.sourceId,
      targetId: row.targetId,
      type: row.type as Relationship["type"],
      strength: row.strength,
      label: row.label ?? undefined,
      notes: row.notes ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // REVIEWS CRUD (Create & List only)
  // ═══════════════════════════════════════════════════════════════

  listReviews(params?: ReviewListParams): Review[] {
    let sql = "SELECT * FROM reviews";
    const conditions: string[] = [];
    const values: any[] = [];

    if (params?.type) {
      conditions.push("type = ?");
      values.push(params.type);
    }
    if (params?.startDate) {
      conditions.push("date >= ?");
      values.push(params.startDate);
    }
    if (params?.endDate) {
      conditions.push("date <= ?");
      values.push(params.endDate);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY date DESC";
    if (params?.limit) sql += ` LIMIT ${params.limit}`;

    const rows = this.db.prepare(sql).all(...values) as any[];
    return rows.map((row) => this.rowToReview(row));
  }

  getReview(id: string): Review | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    return row ? this.rowToReview(row as any) : null;
  }

  createReview(params: ReviewCreateParams): Review {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
      INSERT INTO reviews (id, type, date, priorityProgress, reflections, wins, challenges, nextActions, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        params.type,
        params.date,
        JSON.stringify(params.priorityProgress),
        params.reflections,
        JSON.stringify(params.wins),
        JSON.stringify(params.challenges),
        JSON.stringify(params.nextActions),
        now,
      );

    return this.getReview(id)!;
  }

  deleteReview(id: string): boolean {
    // Reviews are leaf records — nothing references them, so a plain delete
    // is safe (contrast deleteNode, which must clear relationships first).
    const result = this.db.prepare("DELETE FROM reviews WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private rowToReview(row: any): Review {
    return {
      id: row.id,
      type: row.type as Review["type"],
      date: row.date,
      priorityProgress: JSON.parse(row.priorityProgress),
      reflections: row.reflections,
      wins: JSON.parse(row.wins),
      challenges: JSON.parse(row.challenges),
      nextActions: JSON.parse(row.nextActions),
      createdAt: row.createdAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM GRAPH
  // ═══════════════════════════════════════════════════════════════

  getSystemGraph(): SystemGraph {
    return {
      nodes: this.listNodes(),
      relationships: this.listRelationships(),
      values: this.listValues(),
      priorities: this.listPriorities(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTO-LINKING - Smart connection of orphan nodes
  // ═══════════════════════════════════════════════════════════════

  /**
   * Find orphan nodes - nodes not connected to any value, goal, or priority
   */
  findOrphanNodes(): SystemNode[] {
    const relationships = this.listRelationships();
    const values = this.listValues();
    const goals = this.listGoals();
    const priorities = this.listPriorities();
    const nodes = this.listNodes();

    // Build set of all anchor IDs (values, goals, priorities)
    const anchorIds = new Set<string>([
      ...values.map((v) => v.id),
      ...goals.map((g) => g.id),
      ...priorities.map((p) => p.id),
    ]);

    // Trace all nodes connected to anchors
    const connectedIds = new Set<string>();

    const traceConnections = (nodeId: string) => {
      if (connectedIds.has(nodeId)) return;
      connectedIds.add(nodeId);

      // Find all children of this node
      for (const rel of relationships) {
        if (rel.sourceId === nodeId && !connectedIds.has(rel.targetId)) {
          traceConnections(rel.targetId);
        }
      }
    };

    // Start tracing from all anchors
    for (const anchorId of anchorIds) {
      traceConnections(anchorId);
    }

    // Return nodes that aren't connected
    return nodes.filter((n) => !connectedIds.has(n.id));
  }

  /**
   * Calculate similarity score between two strings using multiple techniques
   */
  private calculateSimilarity(text1: string, text2: string): number {
    const t1 = text1.toLowerCase();
    const t2 = text2.toLowerCase();

    // 1. Exact substring match (highest weight)
    if (t1.includes(t2) || t2.includes(t1)) {
      return 0.9;
    }

    // 2. Word overlap (Jaccard similarity)
    const words1 = new Set(t1.split(/\s+/).filter((w) => w.length > 2));
    const words2 = new Set(t2.split(/\s+/).filter((w) => w.length > 2));
    const intersection = new Set([...words1].filter((w) => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    const jaccard = union.size > 0 ? intersection.size / union.size : 0;

    // 3. Keyword matching
    const keywords1 = this.extractKeywords(t1);
    const keywords2 = this.extractKeywords(t2);
    const keywordOverlap = keywords1.filter((k) => keywords2.includes(k)).length;
    const keywordScore =
      keywords1.length + keywords2.length > 0
        ? (keywordOverlap * 2) / (keywords1.length + keywords2.length)
        : 0;

    // Weighted combination
    return jaccard * 0.4 + keywordScore * 0.6;
  }

  /**
   * Extract meaningful keywords from text
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "as",
      "is",
      "was",
      "are",
      "were",
      "been",
      "be",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "can",
      "need",
      "dare",
      "ought",
      "used",
      "get",
      "got",
      "make",
      "made",
      "put",
      "set",
      "take",
      "took",
      "this",
      "that",
      "these",
      "those",
      "it",
      "its",
      "my",
      "your",
      "our",
      "their",
      "his",
      "her",
      "me",
      "him",
      "us",
      "them",
      "i",
      "you",
      "we",
      "they",
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  /**
   * Find the best matching anchor (value/goal/priority) for a node
   */
  findBestMatch(node: SystemNode): {
    anchorId: string;
    anchorType: "value" | "goal" | "priority";
    anchorName: string;
    score: number;
    relationshipType: Relationship["type"];
  } | null {
    const values = this.listValues();
    const goals = this.listGoals();
    const priorities = this.listPriorities();

    // Text to match against (use name, description, and any metadata)
    const nodeMetadata = node.metadata || {};
    const nodeText = `${node.name} ${node.description || ""} ${nodeMetadata.tags?.join(" ") || ""}`;

    let bestMatch: {
      anchorId: string;
      anchorType: "value" | "goal" | "priority";
      anchorName: string;
      score: number;
      relationshipType: Relationship["type"];
    } | null = null;

    // Score against priorities first (closest level for projects/tasks)
    for (const priority of priorities) {
      const priorityText = `${priority.title} ${priority.description || ""}`;
      const score = this.calculateSimilarity(nodeText, priorityText);
      if (score > 0.15 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = {
          anchorId: priority.id,
          anchorType: "priority",
          anchorName: priority.title,
          score,
          relationshipType: "implements",
        };
      }
    }

    // Score against goals
    for (const goal of goals) {
      const goalText = `${goal.title} ${goal.description || ""}`;
      const score = this.calculateSimilarity(nodeText, goalText);
      if (score > 0.2 && (!bestMatch || score > bestMatch.score * 1.1)) {
        bestMatch = {
          anchorId: goal.id,
          anchorType: "goal",
          anchorName: goal.title,
          score,
          relationshipType: "supports",
        };
      }
    }

    // Score against values (need higher threshold)
    for (const value of values) {
      const valueText = `${value.name} ${value.description} ${value.indicators.join(" ")}`;
      const score = this.calculateSimilarity(nodeText, valueText);
      if (score > 0.25 && (!bestMatch || score > bestMatch.score * 1.2)) {
        bestMatch = {
          anchorId: value.id,
          anchorType: "value",
          anchorName: value.name,
          score,
          relationshipType: "enables",
        };
      }
    }

    return bestMatch;
  }

  /**
   * Auto-link orphan nodes to their best matching anchors
   */
  autoLinkOrphans(options?: { minScore?: number; dryRun?: boolean; nodeTypes?: string[] }): {
    linked: Array<{
      nodeId: string;
      nodeLabel: string;
      anchorId: string;
      anchorName: string;
      anchorType: string;
      relationshipType: string;
      score: number;
    }>;
    unmatched: Array<{
      nodeId: string;
      nodeLabel: string;
      bestScore: number;
    }>;
  } {
    const minScore = options?.minScore ?? 0.15;
    const dryRun = options?.dryRun ?? false;
    const nodeTypes = options?.nodeTypes;

    const orphans = this.findOrphanNodes();
    const filteredOrphans = nodeTypes ? orphans.filter((n) => nodeTypes.includes(n.type)) : orphans;

    const linked: Array<{
      nodeId: string;
      nodeLabel: string;
      anchorId: string;
      anchorName: string;
      anchorType: string;
      relationshipType: string;
      score: number;
    }> = [];

    const unmatched: Array<{
      nodeId: string;
      nodeLabel: string;
      bestScore: number;
    }> = [];

    for (const orphan of filteredOrphans) {
      const match = this.findBestMatch(orphan);

      if (match && match.score >= minScore) {
        if (!dryRun) {
          // Create the relationship
          this.createRelationship({
            sourceId: match.anchorId,
            targetId: orphan.id,
            type: match.relationshipType,
            strength: Math.min(match.score + 0.3, 1.0), // Convert score to strength
            label: `Auto-linked (${Math.round(match.score * 100)}% match)`,
          });
        }

        linked.push({
          nodeId: orphan.id,
          nodeLabel: orphan.name,
          anchorId: match.anchorId,
          anchorName: match.anchorName,
          anchorType: match.anchorType,
          relationshipType: match.relationshipType,
          score: match.score,
        });
      } else {
        unmatched.push({
          nodeId: orphan.id,
          nodeLabel: orphan.name,
          bestScore: match?.score ?? 0,
        });
      }
    }

    log.info("Auto-link completed", {
      orphansFound: filteredOrphans.length,
      linked: linked.length,
      unmatched: unmatched.length,
      dryRun,
    });

    return { linked, unmatched };
  }

  /**
   * Get suggestions for linking a specific node
   */
  getSuggestionsForNode(
    nodeId: string,
    limit = 5,
  ): Array<{
    anchorId: string;
    anchorType: string;
    anchorName: string;
    score: number;
    relationshipType: string;
  }> {
    const node = this.getNode(nodeId);
    if (!node) return [];

    const values = this.listValues();
    const goals = this.listGoals();
    const priorities = this.listPriorities();

    const nodeMetadata = node.metadata || {};
    const nodeText = `${node.name} ${node.description || ""} ${nodeMetadata.tags?.join(" ") || ""}`;

    const suggestions: Array<{
      anchorId: string;
      anchorType: string;
      anchorName: string;
      score: number;
      relationshipType: string;
    }> = [];

    // Score all anchors
    for (const priority of priorities) {
      const score = this.calculateSimilarity(
        nodeText,
        `${priority.title} ${priority.description || ""}`,
      );
      if (score > 0.1) {
        suggestions.push({
          anchorId: priority.id,
          anchorType: "priority",
          anchorName: priority.title,
          score,
          relationshipType: "implements",
        });
      }
    }

    for (const goal of goals) {
      const score = this.calculateSimilarity(nodeText, `${goal.title} ${goal.description || ""}`);
      if (score > 0.1) {
        suggestions.push({
          anchorId: goal.id,
          anchorType: "goal",
          anchorName: goal.title,
          score,
          relationshipType: "supports",
        });
      }
    }

    for (const value of values) {
      const score = this.calculateSimilarity(
        nodeText,
        `${value.name} ${value.description} ${value.indicators.join(" ")}`,
      );
      if (score > 0.1) {
        suggestions.push({
          anchorId: value.id,
          anchorType: "value",
          anchorName: value.name,
          score,
          relationshipType: "enables",
        });
      }
    }

    // Sort by score and return top results
    return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let storeInstance: SystemsIntelligenceStore | null = null;

export function getSystemsIntelligenceStore(stateDir?: string): SystemsIntelligenceStore {
  if (!storeInstance && stateDir) {
    storeInstance = new SystemsIntelligenceStore(stateDir);
  }
  if (!storeInstance) {
    throw new Error("Systems Intelligence store not initialized with stateDir");
  }
  return storeInstance;
}

export function resetSystemsIntelligenceStore(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
  }
}

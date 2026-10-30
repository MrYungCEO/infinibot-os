/**
 * Kingly Vault — SQLite Data Store Implementation
 * Full implementation of VaultDataSource using better-sqlite3
 */

import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import type { VaultDataSource } from "./interface.js";
import type {
  VaultMember,
  MemberFilters,
  Warning,
  VaultCourse,
  CourseStatus,
  VaultModule,
  VaultLesson,
  CourseProgress,
  LessonProgress,
  AutomationRule,
  ModerationLog,
  VaultAnalytics,
  MemberTier,
  LessonContent,
  LessonContentType,
  LearningPath,
} from "./types.js";

/**
 * SQLite implementation of VaultDataSource.
 * Uses better-sqlite3 for synchronous operations wrapped in async interface.
 */
export class VaultSqliteStore implements VaultDataSource {
  private db: Database.Database;
  private initialized = false;

  /**
   * Create a new SQLite vault store
   * @param dbPath - Path to the SQLite database file
   */
  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");

    this.createTables();
    this.runMigrations();
    this.seedPriorityCourses();
    this.initialized = true;
  }

  /**
   * Create all database tables with proper schema
   */
  private createTables(): void {
    this.db.exec(`
      -- ═══════════════════════════════════════════════════════════════
      -- MEMBERS TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_members (
        id TEXT PRIMARY KEY,
        discord_id TEXT UNIQUE,
        discord_username TEXT,
        discord_avatar TEXT,
        email TEXT,
        name TEXT,
        tier TEXT DEFAULT 'free',
        roles TEXT DEFAULT '[]',
        status TEXT DEFAULT 'active',
        joined_at TEXT,
        last_active_at TEXT,
        payment_source TEXT,
        payment_id TEXT,
        subscription_status TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_members_discord_id ON vault_members(discord_id);
      CREATE INDEX IF NOT EXISTS idx_members_tier ON vault_members(tier);
      CREATE INDEX IF NOT EXISTS idx_members_status ON vault_members(status);

      -- ═══════════════════════════════════════════════════════════════
      -- WARNINGS TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_warnings (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        severity TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        resolved_by TEXT,
        FOREIGN KEY (member_id) REFERENCES vault_members(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_warnings_member_id ON vault_warnings(member_id);
      CREATE INDEX IF NOT EXISTS idx_warnings_resolved ON vault_warnings(resolved);

      -- ═══════════════════════════════════════════════════════════════
      -- COURSES TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_courses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        cover_image TEXT,
        status TEXT DEFAULT 'draft',
        access_level TEXT DEFAULT 'free',
        required_roles TEXT DEFAULT '[]',
        enrolled_count INTEGER DEFAULT 0,
        completion_rate REAL DEFAULT 0,
        average_rating REAL,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_courses_slug ON vault_courses(slug);
      CREATE INDEX IF NOT EXISTS idx_courses_status ON vault_courses(status);

      -- ═══════════════════════════════════════════════════════════════
      -- MODULES TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_modules (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (course_id) REFERENCES vault_courses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_modules_course_id ON vault_modules(course_id);

      -- ═══════════════════════════════════════════════════════════════
      -- LESSONS TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_lessons (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        content_type TEXT NOT NULL,
        content TEXT NOT NULL,
        duration INTEGER,
        required_for_completion INTEGER DEFAULT 1,
        unlock_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (module_id) REFERENCES vault_modules(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lessons_module_id ON vault_lessons(module_id);

      -- ═══════════════════════════════════════════════════════════════
      -- COURSE PROGRESS TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_progress (
        member_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        enrolled_at TEXT NOT NULL,
        last_accessed_at TEXT,
        completed_at TEXT,
        overall_progress REAL DEFAULT 0,
        quiz_scores TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (member_id, course_id),
        FOREIGN KEY (member_id) REFERENCES vault_members(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES vault_courses(id) ON DELETE CASCADE
      );

      -- ═══════════════════════════════════════════════════════════════
      -- LESSON PROGRESS TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_lesson_progress (
        member_id TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        status TEXT DEFAULT 'not_started',
        started_at TEXT,
        completed_at TEXT,
        time_spent INTEGER DEFAULT 0,
        PRIMARY KEY (member_id, lesson_id),
        FOREIGN KEY (member_id) REFERENCES vault_members(id) ON DELETE CASCADE,
        FOREIGN KEY (lesson_id) REFERENCES vault_lessons(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lesson_progress_member ON vault_lesson_progress(member_id);

      -- ═══════════════════════════════════════════════════════════════
      -- AUTOMATION RULES TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_automation_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        trigger TEXT NOT NULL,
        conditions TEXT DEFAULT '[]',
        actions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_triggered_at TEXT,
        trigger_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_rules_enabled ON vault_automation_rules(enabled);

      -- ═══════════════════════════════════════════════════════════════
      -- MODERATION LOGS TABLE
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_moderation_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_member_id TEXT NOT NULL,
        target_discord_id TEXT,
        performed_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT,
        timestamp TEXT NOT NULL,
        auto_action INTEGER DEFAULT 0,
        rule_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mod_logs_target ON vault_moderation_logs(target_member_id);
      CREATE INDEX IF NOT EXISTS idx_mod_logs_timestamp ON vault_moderation_logs(timestamp);

      -- ═══════════════════════════════════════════════════════════════
      -- ACTIVITY TABLE (for activity feed)
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS vault_activity (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        member_id TEXT,
        member_name TEXT,
        member_avatar TEXT,
        channel_id TEXT,
        channel_name TEXT,
        content TEXT,
        description TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON vault_activity(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_type ON vault_activity(type);
      CREATE INDEX IF NOT EXISTS idx_activity_member ON vault_activity(member_id);
    `);
  }

  private runMigrations(): void {
    try {
      // Safe for DBs created before sort_order was added to the schema
      this.db.exec("ALTER TABLE vault_courses ADD COLUMN sort_order INTEGER DEFAULT 0");
    } catch {
      // Column already exists on DBs initialized with the updated DDL
    }
    try {
      this.db.exec("ALTER TABLE vault_members ADD COLUMN learning_path TEXT");
    } catch {
      // Column already exists
    }
  }

  private seedPriorityCourses(): void {
    const PRIORITY_COURSES = [
      {
        title: "Automations",
        description: "Build no-code agent workflows that run themselves.",
        sortOrder: 1,
      },
      {
        title: "Digital Products",
        description: "Create and sell digital products that generate passive income.",
        sortOrder: 2,
      },
      {
        title: "Mindset",
        description: "Develop the mental frameworks that drive high-performance results.",
        sortOrder: 3,
      },
      {
        title: "Notion Mastery",
        description: "Design powerful Notion systems to organize your life and business.",
        sortOrder: 4,
      },
      {
        title: "Content Creation",
        description: "Build a content engine that attracts and converts your audience.",
        sortOrder: 5,
      },
      {
        title: "AI Images",
        description: "Generate professional-grade visuals with AI image tools.",
        sortOrder: 6,
      },
      {
        title: "Crypto",
        description: "Navigate crypto markets with strategy, risk management, and confidence.",
        sortOrder: 7,
      },
    ] as const;

    try {
      const now = this.now();

      // 100 keeps non-priority courses visually below the 7 pinned slots without hard-coding a ceiling
      this.db.exec(
        `UPDATE vault_courses SET sort_order = 100
         WHERE LOWER(name) NOT IN ('automations','digital products','mindset','notion mastery','content creation','ai images','crypto')`,
      );

      for (const { title, description, sortOrder } of PRIORITY_COURSES) {
        const existing = this.db
          .prepare(
            "SELECT id FROM vault_courses WHERE LOWER(name) = LOWER(?) ORDER BY created_at ASC LIMIT 1",
          )
          .get(title) as { id: string } | undefined;

        if (existing) {
          this.db
            .prepare("UPDATE vault_courses SET sort_order = ? WHERE id = ?")
            .run(sortOrder, existing.id);
        } else {
          const id = crypto.randomUUID();
          const slug = title.toLowerCase().replace(/\s+/g, "-");
          this.db
            .prepare(`
            INSERT INTO vault_courses (
              id, name, slug, description, status, access_level,
              required_roles, enrolled_count, completion_rate, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'draft', 'free', '[]', 0, 0, ?, ?, ?)
          `)
            .run(id, title, slug, description, sortOrder, now, now);
        }
      }
    } catch (err) {
      console.warn("[VaultStore] Priority course seed failed:", err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get current ISO timestamp
   */
  private now(): string {
    return new Date().toISOString();
  }

  /**
   * Generate a new UUID
   */
  private uuid(): string {
    return crypto.randomUUID();
  }

  /**
   * Convert database row to VaultMember object
   */
  private rowToMember(row: any): VaultMember {
    // Fetch warnings for this member
    const warnings = this.db
      .prepare("SELECT * FROM vault_warnings WHERE member_id = ? AND resolved = 0")
      .all(row.id) as any[];

    // Fetch completed courses count
    const completedCourses = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM vault_progress WHERE member_id = ? AND completed_at IS NOT NULL",
      )
      .get(row.id) as { cnt: number };

    // Calculate total progress
    const progressRows = this.db
      .prepare("SELECT overall_progress FROM vault_progress WHERE member_id = ?")
      .all(row.id) as { overall_progress: number }[];

    const totalProgress =
      progressRows.length > 0
        ? progressRows.reduce((sum, p) => sum + p.overall_progress, 0) / progressRows.length
        : 0;

    return {
      id: row.id,
      discordId: row.discord_id ?? undefined,
      discordUsername: row.discord_username ?? undefined,
      discordAvatar: row.discord_avatar ?? undefined,
      email: row.email ?? undefined,
      name: row.name ?? undefined,
      tier: (row.tier ?? "free") as MemberTier,
      roles: JSON.parse(row.roles || "[]"),
      status: row.status ?? "active",
      joinedAt: row.joined_at ?? row.created_at,
      lastActiveAt: row.last_active_at ?? undefined,
      paymentSource: row.payment_source ?? undefined,
      paymentId: row.payment_id ?? undefined,
      subscriptionStatus: row.subscription_status ?? undefined,
      notes: row.notes ?? undefined,
      learningPath: row.learning_path ? JSON.parse(row.learning_path) : null,
      warnings: warnings.map((w) => this.rowToWarning(w)),
      completedCourses: completedCourses?.cnt ?? 0,
      totalProgress: Math.round(totalProgress),
    };
  }

  /**
   * Convert database row to Warning object
   */
  private rowToWarning(row: any): Warning {
    return {
      id: row.id,
      memberId: row.member_id,
      reason: row.reason,
      severity: row.severity,
      issuedBy: row.issued_by,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at ?? undefined,
      resolved: row.resolved === 1,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
    };
  }

  /**
   * Convert database row to VaultCourse object
   */
  private rowToCourse(row: any): VaultCourse {
    // Fetch modules for this course
    const modules = this.getModulesSync(row.id);

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      coverImage: row.cover_image ?? undefined,
      status: row.status as CourseStatus,
      accessLevel: row.access_level,
      requiredRoles: JSON.parse(row.required_roles || "[]"),
      modules,
      enrolledCount: row.enrolled_count ?? 0,
      completionRate: row.completion_rate ?? 0,
      averageRating: row.average_rating ?? undefined,
      sortOrder: row.sort_order ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at ?? undefined,
    };
  }

  /**
   * Get modules synchronously (helper for rowToCourse)
   */
  private getModulesSync(courseId: string): VaultModule[] {
    const rows = this.db
      .prepare("SELECT * FROM vault_modules WHERE course_id = ? ORDER BY sort_order ASC")
      .all(courseId) as any[];

    return rows.map((row) => this.rowToModule(row));
  }

  /**
   * Convert database row to VaultModule object
   */
  private rowToModule(row: any): VaultModule {
    // Fetch lessons for this module
    const lessonRows = this.db
      .prepare("SELECT * FROM vault_lessons WHERE module_id = ? ORDER BY sort_order ASC")
      .all(row.id) as any[];

    return {
      id: row.id,
      courseId: row.course_id,
      name: row.name,
      description: row.description ?? undefined,
      order: row.sort_order ?? 0,
      lessons: lessonRows.map((l) => this.rowToLesson(l)),
    };
  }

  /**
   * Convert database row to VaultLesson object
   */
  private rowToLesson(row: any): VaultLesson {
    return {
      id: row.id,
      moduleId: row.module_id,
      name: row.name,
      description: row.description ?? undefined,
      order: row.sort_order ?? 0,
      contentType: row.content_type as LessonContentType,
      content: JSON.parse(row.content) as LessonContent,
      duration: row.duration ?? undefined,
      requiredForCompletion: row.required_for_completion === 1,
      unlockAfter: row.unlock_after ?? undefined,
    };
  }

  /**
   * Convert database row to CourseProgress object
   */
  private rowToProgress(row: any, memberId: string): CourseProgress {
    // Fetch lesson progress for this course
    const lessonProgress = this.getLessonProgressSync(memberId, row.course_id);

    return {
      memberId,
      courseId: row.course_id,
      enrolledAt: row.enrolled_at,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      lessonProgress,
      overallProgress: row.overall_progress ?? 0,
      quizScores: JSON.parse(row.quiz_scores || "[]"),
    };
  }

  /**
   * Get lesson progress synchronously (helper)
   */
  private getLessonProgressSync(memberId: string, courseId: string): LessonProgress[] {
    // Get all lessons for this course
    const lessons = this.db
      .prepare(`
      SELECT l.id FROM vault_lessons l
      JOIN vault_modules m ON l.module_id = m.id
      WHERE m.course_id = ?
    `)
      .all(courseId) as { id: string }[];

    const lessonIds = lessons.map((l) => l.id);
    if (lessonIds.length === 0) return [];

    // Get progress for these lessons
    const placeholders = lessonIds.map(() => "?").join(",");
    const progressRows = this.db
      .prepare(`
      SELECT * FROM vault_lesson_progress
      WHERE member_id = ? AND lesson_id IN (${placeholders})
    `)
      .all(memberId, ...lessonIds) as any[];

    // Create progress map
    const progressMap = new Map(progressRows.map((p) => [p.lesson_id, p]));

    // Return progress for all lessons
    return lessonIds.map((lessonId) => {
      const p = progressMap.get(lessonId);
      return {
        lessonId,
        status: p?.status ?? "not_started",
        startedAt: p?.started_at ?? undefined,
        completedAt: p?.completed_at ?? undefined,
        timeSpent: p?.time_spent ?? undefined,
      };
    });
  }

  /**
   * Convert database row to AutomationRule object
   */
  private rowToRule(row: any): AutomationRule {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      trigger: JSON.parse(row.trigger),
      conditions: JSON.parse(row.conditions || "[]"),
      actions: JSON.parse(row.actions),
      createdAt: row.created_at,
      lastTriggeredAt: row.last_triggered_at ?? undefined,
      triggerCount: row.trigger_count ?? 0,
    };
  }

  /**
   * Convert database row to ModerationLog object
   */
  private rowToModLog(row: any): ModerationLog {
    return {
      id: row.id,
      action: row.action,
      targetMemberId: row.target_member_id,
      targetDiscordId: row.target_discord_id ?? undefined,
      performedBy: row.performed_by,
      reason: row.reason,
      details: row.details ? JSON.parse(row.details) : undefined,
      timestamp: row.timestamp,
      autoAction: row.auto_action === 1,
      ruleId: row.rule_id ?? undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // MEMBERS IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getMembers(filters?: MemberFilters): Promise<VaultMember[]> {
    let sql = "SELECT * FROM vault_members WHERE 1=1";
    const params: any[] = [];

    if (filters) {
      if (filters.tier) {
        const tiers = Array.isArray(filters.tier) ? filters.tier : [filters.tier];
        const placeholders = tiers.map(() => "?").join(",");
        sql += ` AND tier IN (${placeholders})`;
        params.push(...tiers);
      }

      if (filters.status) {
        sql += " AND status = ?";
        params.push(filters.status);
      }

      if (filters.search) {
        sql += " AND (name LIKE ? OR discord_username LIKE ? OR email LIKE ?)";
        const search = `%${filters.search}%`;
        params.push(search, search, search);
      }

      if (filters.discordRoleId) {
        sql += " AND roles LIKE ?";
        params.push(`%"${filters.discordRoleId}"%`);
      }

      if (filters.hasWarnings !== undefined) {
        if (filters.hasWarnings) {
          sql += " AND id IN (SELECT DISTINCT member_id FROM vault_warnings WHERE resolved = 0)";
        } else {
          sql +=
            " AND id NOT IN (SELECT DISTINCT member_id FROM vault_warnings WHERE resolved = 0)";
        }
      }

      if (filters.courseId) {
        if (filters.courseCompleted !== undefined) {
          if (filters.courseCompleted) {
            sql +=
              " AND id IN (SELECT member_id FROM vault_progress WHERE course_id = ? AND completed_at IS NOT NULL)";
          } else {
            sql +=
              " AND id IN (SELECT member_id FROM vault_progress WHERE course_id = ? AND completed_at IS NULL)";
          }
        } else {
          sql += " AND id IN (SELECT member_id FROM vault_progress WHERE course_id = ?)";
        }
        params.push(filters.courseId);
      }

      sql += " ORDER BY created_at DESC";

      if (filters.limit) {
        sql += " LIMIT ?";
        params.push(filters.limit);
      }

      if (filters.offset) {
        sql += " OFFSET ?";
        params.push(filters.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => this.rowToMember(row));
  }

  async getMember(id: string): Promise<VaultMember | null> {
    const row = this.db.prepare("SELECT * FROM vault_members WHERE id = ?").get(id) as any;
    return row ? this.rowToMember(row) : null;
  }

  async getMemberByDiscord(discordId: string): Promise<VaultMember | null> {
    const row = this.db
      .prepare("SELECT * FROM vault_members WHERE discord_id = ?")
      .get(discordId) as any;
    return row ? this.rowToMember(row) : null;
  }

  async upsertMember(member: Partial<VaultMember> & { id: string }): Promise<VaultMember> {
    const now = this.now();
    const existing = await this.getMember(member.id);

    if (existing) {
      // Update existing
      const updated = { ...existing, ...member };
      this.db
        .prepare(`
        UPDATE vault_members SET
          discord_id = ?,
          discord_username = ?,
          discord_avatar = ?,
          email = ?,
          name = ?,
          tier = ?,
          roles = ?,
          status = ?,
          joined_at = ?,
          last_active_at = ?,
          payment_source = ?,
          payment_id = ?,
          subscription_status = ?,
          notes = ?,
          learning_path = ?,
          updated_at = ?
        WHERE id = ?
      `)
        .run(
          updated.discordId ?? null,
          updated.discordUsername ?? null,
          updated.discordAvatar ?? null,
          updated.email ?? null,
          updated.name ?? null,
          updated.tier,
          JSON.stringify(updated.roles),
          updated.status,
          updated.joinedAt,
          updated.lastActiveAt ?? null,
          updated.paymentSource ?? null,
          updated.paymentId ?? null,
          updated.subscriptionStatus ?? null,
          updated.notes ?? null,
          updated.learningPath ? JSON.stringify(updated.learningPath) : null,
          now,
          member.id,
        );
    } else {
      // Insert new
      this.db
        .prepare(`
        INSERT INTO vault_members (
          id, discord_id, discord_username, discord_avatar, email, name,
          tier, roles, status, joined_at, last_active_at,
          payment_source, payment_id, subscription_status, notes,
          learning_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          member.id,
          member.discordId ?? null,
          member.discordUsername ?? null,
          member.discordAvatar ?? null,
          member.email ?? null,
          member.name ?? null,
          member.tier ?? "free",
          JSON.stringify(member.roles ?? []),
          member.status ?? "active",
          member.joinedAt ?? now,
          member.lastActiveAt ?? null,
          member.paymentSource ?? null,
          member.paymentId ?? null,
          member.subscriptionStatus ?? null,
          member.notes ?? null,
          member.learningPath ? JSON.stringify(member.learningPath) : null,
          now,
          now,
        );
    }

    return (await this.getMember(member.id))!;
  }

  async deleteMember(id: string): Promise<void> {
    this.db.prepare("DELETE FROM vault_members WHERE id = ?").run(id);
  }

  async getLearningPath(memberId: string): Promise<LearningPath | null> {
    const row = this.db
      .prepare("SELECT learning_path FROM vault_members WHERE id = ?")
      .get(memberId) as { learning_path: string | null } | undefined;
    if (!row?.learning_path) return null;
    return JSON.parse(row.learning_path) as LearningPath;
  }

  async saveLearningPath(path: LearningPath): Promise<void> {
    this.db
      .prepare("UPDATE vault_members SET learning_path = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(path), this.now(), path.memberId);
  }

  // ═══════════════════════════════════════════════════════════════
  // WARNINGS IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async addWarning(warning: Omit<Warning, "id">): Promise<Warning> {
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO vault_warnings (
        id, member_id, reason, severity, issued_by, issued_at,
        expires_at, resolved, resolved_at, resolved_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        warning.memberId,
        warning.reason,
        warning.severity,
        warning.issuedBy,
        warning.issuedAt,
        warning.expiresAt ?? null,
        warning.resolved ? 1 : 0,
        warning.resolvedAt ?? null,
        warning.resolvedBy ?? null,
      );

    return { id, ...warning };
  }

  async resolveWarning(warningId: string, resolvedBy: string): Promise<void> {
    const now = this.now();
    this.db
      .prepare(`
      UPDATE vault_warnings SET
        resolved = 1,
        resolved_at = ?,
        resolved_by = ?
      WHERE id = ?
    `)
      .run(now, resolvedBy, warningId);
  }

  async clearWarnings(memberId: string): Promise<void> {
    const now = this.now();
    this.db
      .prepare(`
      UPDATE vault_warnings SET
        resolved = 1,
        resolved_at = ?,
        resolved_by = 'system'
      WHERE member_id = ? AND resolved = 0
    `)
      .run(now, memberId);
  }

  // ═══════════════════════════════════════════════════════════════
  // COURSES IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getCourses(status?: CourseStatus): Promise<VaultCourse[]> {
    let sql = "SELECT * FROM vault_courses";
    const params: any[] = [];

    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }

    sql += " ORDER BY sort_order ASC, created_at DESC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => this.rowToCourse(row));
  }

  async getCourse(id: string): Promise<VaultCourse | null> {
    const row = this.db.prepare("SELECT * FROM vault_courses WHERE id = ?").get(id) as any;
    return row ? this.rowToCourse(row) : null;
  }

  async getCourseBySlug(slug: string): Promise<VaultCourse | null> {
    const row = this.db.prepare("SELECT * FROM vault_courses WHERE slug = ?").get(slug) as any;
    return row ? this.rowToCourse(row) : null;
  }

  async upsertCourse(course: Partial<VaultCourse> & { id: string }): Promise<VaultCourse> {
    const now = this.now();
    const existing = await this.getCourse(course.id);

    if (existing) {
      // Update existing
      const updated = { ...existing, ...course };
      this.db
        .prepare(`
        UPDATE vault_courses SET
          name = ?,
          slug = ?,
          description = ?,
          cover_image = ?,
          status = ?,
          access_level = ?,
          required_roles = ?,
          enrolled_count = ?,
          completion_rate = ?,
          average_rating = ?,
          sort_order = ?,
          updated_at = ?,
          published_at = ?
        WHERE id = ?
      `)
        .run(
          updated.name,
          updated.slug,
          updated.description,
          updated.coverImage ?? null,
          updated.status,
          updated.accessLevel,
          JSON.stringify(updated.requiredRoles ?? []),
          updated.enrolledCount,
          updated.completionRate,
          updated.averageRating ?? null,
          updated.sortOrder ?? 0,
          now,
          updated.publishedAt ?? null,
          course.id,
        );
    } else {
      // Insert new
      this.db
        .prepare(`
        INSERT INTO vault_courses (
          id, name, slug, description, cover_image, status,
          access_level, required_roles, enrolled_count, completion_rate,
          average_rating, sort_order, created_at, updated_at, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          course.id,
          course.name ?? "Untitled Course",
          course.slug ?? course.id,
          course.description ?? "",
          course.coverImage ?? null,
          course.status ?? "draft",
          course.accessLevel ?? "free",
          JSON.stringify(course.requiredRoles ?? []),
          course.enrolledCount ?? 0,
          course.completionRate ?? 0,
          course.averageRating ?? null,
          course.sortOrder ?? 0,
          now,
          now,
          course.publishedAt ?? null,
        );
    }

    return (await this.getCourse(course.id))!;
  }

  async deleteCourse(id: string): Promise<void> {
    // Cascade delete will handle modules and lessons
    this.db.prepare("DELETE FROM vault_courses WHERE id = ?").run(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // MODULES IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getModules(courseId: string): Promise<VaultModule[]> {
    const rows = this.db
      .prepare("SELECT * FROM vault_modules WHERE course_id = ? ORDER BY sort_order ASC")
      .all(courseId) as any[];
    return rows.map((row) => this.rowToModule(row));
  }

  async upsertModule(
    module: Partial<VaultModule> & { id: string; courseId: string },
  ): Promise<VaultModule> {
    const now = this.now();
    const existing = this.db
      .prepare("SELECT * FROM vault_modules WHERE id = ?")
      .get(module.id) as any;

    if (existing) {
      // Update existing
      this.db
        .prepare(`
        UPDATE vault_modules SET
          course_id = ?,
          name = ?,
          description = ?,
          sort_order = ?,
          updated_at = ?
        WHERE id = ?
      `)
        .run(
          module.courseId,
          module.name ?? existing.name,
          module.description ?? existing.description,
          module.order ?? existing.sort_order,
          now,
          module.id,
        );
    } else {
      // Insert new
      this.db
        .prepare(`
        INSERT INTO vault_modules (
          id, course_id, name, description, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          module.id,
          module.courseId,
          module.name ?? "Untitled Module",
          module.description ?? null,
          module.order ?? 0,
          now,
          now,
        );
    }

    const row = this.db.prepare("SELECT * FROM vault_modules WHERE id = ?").get(module.id) as any;
    return this.rowToModule(row);
  }

  async deleteModule(id: string): Promise<void> {
    // Cascade delete will handle lessons
    this.db.prepare("DELETE FROM vault_modules WHERE id = ?").run(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // LESSONS IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getLessons(moduleId: string): Promise<VaultLesson[]> {
    const rows = this.db
      .prepare("SELECT * FROM vault_lessons WHERE module_id = ? ORDER BY sort_order ASC")
      .all(moduleId) as any[];
    return rows.map((row) => this.rowToLesson(row));
  }

  async upsertLesson(
    lesson: Partial<VaultLesson> & { id: string; moduleId: string },
  ): Promise<VaultLesson> {
    const now = this.now();
    const existing = this.db
      .prepare("SELECT * FROM vault_lessons WHERE id = ?")
      .get(lesson.id) as any;

    if (existing) {
      // Update existing
      this.db
        .prepare(`
        UPDATE vault_lessons SET
          module_id = ?,
          name = ?,
          description = ?,
          sort_order = ?,
          content_type = ?,
          content = ?,
          duration = ?,
          required_for_completion = ?,
          unlock_after = ?,
          updated_at = ?
        WHERE id = ?
      `)
        .run(
          lesson.moduleId,
          lesson.name ?? existing.name,
          lesson.description ?? existing.description,
          lesson.order ?? existing.sort_order,
          lesson.contentType ?? existing.content_type,
          JSON.stringify(lesson.content ?? JSON.parse(existing.content)),
          lesson.duration ?? existing.duration,
          lesson.requiredForCompletion === undefined
            ? existing.required_for_completion
            : lesson.requiredForCompletion
              ? 1
              : 0,
          lesson.unlockAfter ?? existing.unlock_after,
          now,
          lesson.id,
        );
    } else {
      // Insert new
      this.db
        .prepare(`
        INSERT INTO vault_lessons (
          id, module_id, name, description, sort_order, content_type,
          content, duration, required_for_completion, unlock_after,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          lesson.id,
          lesson.moduleId,
          lesson.name ?? "Untitled Lesson",
          lesson.description ?? null,
          lesson.order ?? 0,
          lesson.contentType ?? "text",
          JSON.stringify(lesson.content ?? { type: "text", markdown: "" }),
          lesson.duration ?? null,
          lesson.requiredForCompletion === false ? 0 : 1,
          lesson.unlockAfter ?? null,
          now,
          now,
        );
    }

    const row = this.db.prepare("SELECT * FROM vault_lessons WHERE id = ?").get(lesson.id) as any;
    return this.rowToLesson(row);
  }

  async deleteLesson(id: string): Promise<void> {
    this.db.prepare("DELETE FROM vault_lessons WHERE id = ?").run(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getProgress(memberId: string, courseId?: string): Promise<CourseProgress[]> {
    let sql = "SELECT * FROM vault_progress WHERE member_id = ?";
    const params: any[] = [memberId];

    if (courseId) {
      sql += " AND course_id = ?";
      params.push(courseId);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => this.rowToProgress(row, memberId));
  }

  async updateLessonProgress(
    memberId: string,
    lessonId: string,
    status: LessonProgress["status"],
  ): Promise<void> {
    const now = this.now();
    const existing = this.db
      .prepare("SELECT * FROM vault_lesson_progress WHERE member_id = ? AND lesson_id = ?")
      .get(memberId, lessonId) as any;

    if (existing) {
      const updates: any = { status };
      if (status === "in_progress" && !existing.started_at) {
        updates.started_at = now;
      }
      if (status === "completed" && !existing.completed_at) {
        updates.completed_at = now;
      }

      this.db
        .prepare(`
        UPDATE vault_lesson_progress SET
          status = ?,
          started_at = COALESCE(?, started_at),
          completed_at = COALESCE(?, completed_at)
        WHERE member_id = ? AND lesson_id = ?
      `)
        .run(
          updates.status,
          updates.started_at ?? null,
          updates.completed_at ?? null,
          memberId,
          lessonId,
        );
    } else {
      this.db
        .prepare(`
        INSERT INTO vault_lesson_progress (
          member_id, lesson_id, status, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
        .run(
          memberId,
          lessonId,
          status,
          status === "in_progress" || status === "completed" ? now : null,
          status === "completed" ? now : null,
        );
    }

    // Update overall course progress
    await this.recalculateCourseProgress(memberId, lessonId);
  }

  /**
   * Recalculate course progress after lesson update
   */
  private async recalculateCourseProgress(memberId: string, lessonId: string): Promise<void> {
    // Find the course for this lesson
    const lesson = this.db
      .prepare(`
      SELECT m.course_id FROM vault_lessons l
      JOIN vault_modules m ON l.module_id = m.id
      WHERE l.id = ?
    `)
      .get(lessonId) as { course_id: string } | undefined;

    if (!lesson) return;

    const courseId = lesson.course_id;

    // Count total required lessons
    const totalLessons = this.db
      .prepare(`
      SELECT COUNT(*) as cnt FROM vault_lessons l
      JOIN vault_modules m ON l.module_id = m.id
      WHERE m.course_id = ? AND l.required_for_completion = 1
    `)
      .get(courseId) as { cnt: number };

    // Count completed required lessons
    const completedLessons = this.db
      .prepare(`
      SELECT COUNT(*) as cnt FROM vault_lesson_progress lp
      JOIN vault_lessons l ON lp.lesson_id = l.id
      JOIN vault_modules m ON l.module_id = m.id
      WHERE lp.member_id = ? AND m.course_id = ? 
        AND lp.status = 'completed' AND l.required_for_completion = 1
    `)
      .get(memberId, courseId) as { cnt: number };

    const progress =
      totalLessons.cnt > 0 ? Math.round((completedLessons.cnt / totalLessons.cnt) * 100) : 0;

    const now = this.now();
    const isComplete = progress === 100;

    // Update course progress
    this.db
      .prepare(`
      UPDATE vault_progress SET
        overall_progress = ?,
        last_accessed_at = ?,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        updated_at = ?
      WHERE member_id = ? AND course_id = ?
    `)
      .run(progress, now, isComplete ? 1 : 0, isComplete ? now : null, now, memberId, courseId);
  }

  async enrollInCourse(memberId: string, courseId: string): Promise<CourseProgress> {
    const now = this.now();

    // Check if already enrolled
    const existing = this.db
      .prepare("SELECT * FROM vault_progress WHERE member_id = ? AND course_id = ?")
      .get(memberId, courseId);

    if (existing) {
      const progress = await this.getProgress(memberId, courseId);
      return progress[0];
    }

    // Create enrollment
    this.db
      .prepare(`
      INSERT INTO vault_progress (
        member_id, course_id, enrolled_at, overall_progress, quiz_scores,
        created_at, updated_at
      ) VALUES (?, ?, ?, 0, '[]', ?, ?)
    `)
      .run(memberId, courseId, now, now, now);

    // Update enrolled count on course
    this.db
      .prepare(`
      UPDATE vault_courses SET enrolled_count = enrolled_count + 1 WHERE id = ?
    `)
      .run(courseId);

    const progress = await this.getProgress(memberId, courseId);
    return progress[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTOMATION RULES IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getRules(): Promise<AutomationRule[]> {
    const rows = this.db
      .prepare("SELECT * FROM vault_automation_rules ORDER BY created_at DESC")
      .all() as any[];
    return rows.map((row) => this.rowToRule(row));
  }

  async getRule(id: string): Promise<AutomationRule | null> {
    const row = this.db.prepare("SELECT * FROM vault_automation_rules WHERE id = ?").get(id) as any;
    return row ? this.rowToRule(row) : null;
  }

  async upsertRule(rule: Partial<AutomationRule> & { id: string }): Promise<AutomationRule> {
    const now = this.now();
    const existing = await this.getRule(rule.id);

    if (existing) {
      // Update existing
      const updated = { ...existing, ...rule };
      this.db
        .prepare(`
        UPDATE vault_automation_rules SET
          name = ?,
          description = ?,
          enabled = ?,
          trigger = ?,
          conditions = ?,
          actions = ?,
          last_triggered_at = ?,
          trigger_count = ?
        WHERE id = ?
      `)
        .run(
          updated.name,
          updated.description ?? null,
          updated.enabled ? 1 : 0,
          JSON.stringify(updated.trigger),
          JSON.stringify(updated.conditions),
          JSON.stringify(updated.actions),
          updated.lastTriggeredAt ?? null,
          updated.triggerCount,
          rule.id,
        );
    } else {
      // Insert new
      this.db
        .prepare(`
        INSERT INTO vault_automation_rules (
          id, name, description, enabled, trigger, conditions, actions,
          created_at, trigger_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `)
        .run(
          rule.id,
          rule.name ?? "Untitled Rule",
          rule.description ?? null,
          rule.enabled === false ? 0 : 1,
          JSON.stringify(rule.trigger ?? { type: "member_join" }),
          JSON.stringify(rule.conditions ?? []),
          JSON.stringify(rule.actions ?? []),
          now,
        );
    }

    return (await this.getRule(rule.id))!;
  }

  async deleteRule(id: string): Promise<void> {
    this.db.prepare("DELETE FROM vault_automation_rules WHERE id = ?").run(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // MODERATION LOGS IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async addModerationLog(log: Omit<ModerationLog, "id">): Promise<ModerationLog> {
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO vault_moderation_logs (
        id, action, target_member_id, target_discord_id, performed_by,
        reason, details, timestamp, auto_action, rule_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        log.action,
        log.targetMemberId,
        log.targetDiscordId ?? null,
        log.performedBy,
        log.reason,
        log.details ? JSON.stringify(log.details) : null,
        log.timestamp,
        log.autoAction ? 1 : 0,
        log.ruleId ?? null,
      );

    return { id, ...log };
  }

  async getModerationLogs(memberId?: string, limit?: number): Promise<ModerationLog[]> {
    let sql = "SELECT * FROM vault_moderation_logs";
    const params: any[] = [];

    if (memberId) {
      sql += " WHERE target_member_id = ?";
      params.push(memberId);
    }

    sql += " ORDER BY timestamp DESC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => this.rowToModLog(row));
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════

  async getAnalytics(start: string, end: string): Promise<VaultAnalytics> {
    // Members stats
    const totalMembers = (this.db.prepare("SELECT COUNT(*) as cnt FROM vault_members").get() as any)
      .cnt;
    const activeMembers = (
      this.db
        .prepare("SELECT COUNT(*) as cnt FROM vault_members WHERE status = 'active'")
        .get() as any
    ).cnt;
    const newMembers = (
      this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM vault_members WHERE joined_at >= ? AND joined_at <= ?",
        )
        .get(start, end) as any
    ).cnt;

    // Members by tier
    const tierRows = this.db
      .prepare("SELECT tier, COUNT(*) as cnt FROM vault_members GROUP BY tier")
      .all() as { tier: string; cnt: number }[];
    const byTier: Record<MemberTier, number> = {
      free: 0,
      basic: 0,
      paid: 0,
      premium: 0,
      vip: 0,
      lifetime: 0,
      admin: 0,
    };
    for (const row of tierRows) {
      byTier[row.tier as MemberTier] = row.cnt;
    }

    // Course stats
    const totalEnrollments = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM vault_progress").get() as any
    ).cnt;
    const completions = (
      this.db
        .prepare("SELECT COUNT(*) as cnt FROM vault_progress WHERE completed_at IS NOT NULL")
        .get() as any
    ).cnt;
    const avgProgressRow = this.db
      .prepare("SELECT AVG(overall_progress) as avg FROM vault_progress")
      .get() as { avg: number | null };

    // Top courses
    const topCoursesRows = this.db
      .prepare(`
      SELECT c.id, c.name, 
        COUNT(p.member_id) as enrollments,
        AVG(CASE WHEN p.completed_at IS NOT NULL THEN 100 ELSE p.overall_progress END) as completion_rate
      FROM vault_courses c
      LEFT JOIN vault_progress p ON c.id = p.course_id
      GROUP BY c.id
      ORDER BY enrollments DESC
      LIMIT 5
    `)
      .all() as any[];

    // Engagement
    const lessonsCompleted = (
      this.db
        .prepare(`
      SELECT COUNT(*) as cnt FROM vault_lesson_progress 
      WHERE status = 'completed' AND completed_at >= ? AND completed_at <= ?
    `)
        .get(start, end) as any
    ).cnt;

    // Moderation stats
    const modStats = this.db
      .prepare(`
      SELECT action, COUNT(*) as cnt FROM vault_moderation_logs
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY action
    `)
      .all(start, end) as { action: string; cnt: number }[];

    const modCounts: Record<string, number> = {};
    for (const row of modStats) {
      modCounts[row.action] = row.cnt;
    }

    // Get recent activity from activity table
    const activityRows = this.db
      .prepare(`
      SELECT * FROM vault_activity 
      ORDER BY timestamp DESC 
      LIMIT 20
    `)
      .all() as any[];

    const recentActivity = activityRows.map((row) => ({
      id: row.id,
      type: row.type,
      memberId: row.member_id ?? undefined,
      memberName: row.member_name ?? undefined,
      memberAvatar: row.member_avatar ?? undefined,
      channelId: row.channel_id ?? undefined,
      channelName: row.channel_name ?? undefined,
      content: row.content ?? undefined,
      description: row.description,
      timestamp: row.timestamp,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));

    // Also include recent member joins if activity table is empty
    if (recentActivity.length === 0) {
      const recentJoins = this.db
        .prepare(`
        SELECT id, discord_username, discord_avatar, joined_at 
        FROM vault_members 
        ORDER BY joined_at DESC 
        LIMIT 10
      `)
        .all() as any[];

      for (const m of recentJoins) {
        recentActivity.push({
          id: `join-${m.id}`,
          type: "member_join",
          memberId: m.id,
          memberName: m.discord_username,
          memberAvatar: m.discord_avatar,
          channelId: undefined,
          channelName: undefined,
          content: undefined,
          description: "joined the community",
          timestamp: m.joined_at,
          metadata: undefined,
        });
      }
    }

    // Total courses
    const totalCourses = (this.db.prepare("SELECT COUNT(*) as cnt FROM vault_courses").get() as any)
      .cnt;

    // Total/active warnings
    const totalWarnings = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM vault_warnings").get() as any
    ).cnt;
    const activeWarnings = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM vault_warnings WHERE resolved = 0").get() as any
    ).cnt;

    return {
      period: { start, end },
      members: {
        total: totalMembers,
        active: activeMembers,
        new: newMembers,
        churned: 0, // Would need more tracking for this
        byTier,
      },
      courses: {
        totalEnrollments,
        completions,
        averageProgress: Math.round(avgProgressRow.avg ?? 0),
        topCourses: topCoursesRows.map((r) => ({
          courseId: r.id,
          name: r.name,
          enrollments: r.enrollments,
          completionRate: Math.round(r.completion_rate ?? 0),
        })),
      },
      engagement: {
        dailyActiveUsers: [], // Would need event tracking
        averageSessionDuration: 0, // Would need session tracking
        lessonsCompleted,
        quizzesPassed: 0, // Would need quiz tracking
      },
      moderation: {
        warnings: modCounts["warn"] ?? 0,
        timeouts: modCounts["timeout"] ?? 0,
        kicks: modCounts["kick"] ?? 0,
        bans: modCounts["ban"] ?? 0,
      },
      // Activity feed
      recentActivity,
      // UI compatibility aliases
      totalMembers,
      activeMembers,
      newMembersThisWeek: newMembers,
      newMembersThisMonth: newMembers,
      totalCourses,
      totalWarnings,
      activeWarnings,
      churnRate: 0,
      averageEngagement: 0,
      topCourses: topCoursesRows.map((r) => ({
        id: r.id,
        title: r.name,
        enrollments: r.enrollments,
      })),
    };
  }

  /**
   * Add an activity event
   */
  async addActivity(activity: {
    type: string;
    memberId?: string;
    memberName?: string;
    memberAvatar?: string;
    channelId?: string;
    channelName?: string;
    content?: string;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO vault_activity (
        id, type, member_id, member_name, member_avatar, 
        channel_id, channel_name, content, description, timestamp, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        activity.type,
        activity.memberId ?? null,
        activity.memberName ?? null,
        activity.memberAvatar ?? null,
        activity.channelId ?? null,
        activity.channelName ?? null,
        activity.content ?? null,
        activity.description,
        now,
        activity.metadata ? JSON.stringify(activity.metadata) : null,
      );
  }

  /**
   * Get recent activity events
   */
  async getRecentActivity(limit: number = 20): Promise<any[]> {
    const rows = this.db
      .prepare(`
      SELECT * FROM vault_activity 
      ORDER BY timestamp DESC 
      LIMIT ?
    `)
      .all(limit) as any[];

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      memberId: row.member_id ?? undefined,
      memberName: row.member_name ?? undefined,
      memberAvatar: row.member_avatar ?? undefined,
      channelId: row.channel_id ?? undefined,
      channelName: row.channel_name ?? undefined,
      content: row.content ?? undefined,
      description: row.description,
      timestamp: row.timestamp,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

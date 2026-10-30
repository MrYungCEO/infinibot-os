/**
 * Kingly Vault — Data Source Interface
 * Abstract interface for all vault data stores (SQLite, Notion, etc.)
 */

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
  LearningPath,
} from "./types.js";

/**
 * Abstract data source interface for Kingly Vault.
 * Implementations can be SQLite, Notion, or composite (multiple sources).
 * All methods are async for future-proofing even if sync internally.
 */
export interface VaultDataSource {
  // ═══════════════════════════════════════════════════════════════
  // MEMBERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all members matching optional filters
   * @param filters - Optional filters for querying members
   * @returns Array of matching members
   */
  getMembers(filters?: MemberFilters): Promise<VaultMember[]>;

  /**
   * Get a single member by their vault ID
   * @param id - The vault member ID
   * @returns Member or null if not found
   */
  getMember(id: string): Promise<VaultMember | null>;

  /**
   * Get a member by their Discord ID
   * @param discordId - The Discord user ID
   * @returns Member or null if not found
   */
  getMemberByDiscord(discordId: string): Promise<VaultMember | null>;

  /**
   * Create or update a member
   * @param member - Partial member data with required ID
   * @returns The upserted member with all fields
   */
  upsertMember(member: Partial<VaultMember> & { id: string }): Promise<VaultMember>;

  /**
   * Delete a member permanently
   * @param id - The vault member ID
   */
  deleteMember(id: string): Promise<void>;

  /**
   * Get the learning path for a member
   * @param memberId - The vault member ID
   * @returns Learning path or null
   */
  getLearningPath(memberId: string): Promise<LearningPath | null>;

  /**
   * Save a learning path for a member
   * @param path - The learning path to save
   */
  saveLearningPath(path: LearningPath): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // WARNINGS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Add a warning to a member
   * @param warning - Warning data without ID (will be generated)
   * @returns The created warning with ID
   */
  addWarning(warning: Omit<Warning, "id">): Promise<Warning>;

  /**
   * Mark a warning as resolved
   * @param warningId - The warning ID
   * @param resolvedBy - User ID or 'ash' who resolved it
   */
  resolveWarning(warningId: string, resolvedBy: string): Promise<void>;

  /**
   * Clear all warnings for a member
   * @param memberId - The vault member ID
   */
  clearWarnings(memberId: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // COURSES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all courses, optionally filtered by status
   * @param status - Optional course status filter
   * @returns Array of courses with modules populated
   */
  getCourses(status?: CourseStatus): Promise<VaultCourse[]>;

  /**
   * Get a single course by ID
   * @param id - The course ID
   * @returns Course with modules or null if not found
   */
  getCourse(id: string): Promise<VaultCourse | null>;

  /**
   * Get a course by its URL slug
   * @param slug - The course URL slug
   * @returns Course or null if not found
   */
  getCourseBySlug(slug: string): Promise<VaultCourse | null>;

  /**
   * Create or update a course
   * @param course - Partial course data with required ID
   * @returns The upserted course
   */
  upsertCourse(course: Partial<VaultCourse> & { id: string }): Promise<VaultCourse>;

  /**
   * Delete a course and all its modules/lessons
   * @param id - The course ID
   */
  deleteCourse(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // MODULES & LESSONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all modules for a course
   * @param courseId - The course ID
   * @returns Array of modules with lessons populated
   */
  getModules(courseId: string): Promise<VaultModule[]>;

  /**
   * Create or update a module
   * @param module - Partial module data with required ID and courseId
   * @returns The upserted module
   */
  upsertModule(
    module: Partial<VaultModule> & { id: string; courseId: string },
  ): Promise<VaultModule>;

  /**
   * Delete a module and all its lessons
   * @param id - The module ID
   */
  deleteModule(id: string): Promise<void>;

  /**
   * Get all lessons for a module
   * @param moduleId - The module ID
   * @returns Array of lessons
   */
  getLessons(moduleId: string): Promise<VaultLesson[]>;

  /**
   * Create or update a lesson
   * @param lesson - Partial lesson data with required ID and moduleId
   * @returns The upserted lesson
   */
  upsertLesson(
    lesson: Partial<VaultLesson> & { id: string; moduleId: string },
  ): Promise<VaultLesson>;

  /**
   * Delete a lesson
   * @param id - The lesson ID
   */
  deleteLesson(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS TRACKING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get progress records for a member
   * @param memberId - The vault member ID
   * @param courseId - Optional course ID to filter by
   * @returns Array of progress records
   */
  getProgress(memberId: string, courseId?: string): Promise<CourseProgress[]>;

  /**
   * Update lesson progress status
   * @param memberId - The vault member ID
   * @param lessonId - The lesson ID
   * @param status - The new lesson status
   */
  updateLessonProgress(
    memberId: string,
    lessonId: string,
    status: LessonProgress["status"],
  ): Promise<void>;

  /**
   * Enroll a member in a course
   * @param memberId - The vault member ID
   * @param courseId - The course ID
   * @returns The initial progress record
   */
  enrollInCourse(memberId: string, courseId: string): Promise<CourseProgress>;

  // ═══════════════════════════════════════════════════════════════
  // AUTOMATION RULES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all automation rules
   * @returns Array of all rules
   */
  getRules(): Promise<AutomationRule[]>;

  /**
   * Get a single rule by ID
   * @param id - The rule ID
   * @returns Rule or null if not found
   */
  getRule(id: string): Promise<AutomationRule | null>;

  /**
   * Create or update an automation rule
   * @param rule - Partial rule data with required ID
   * @returns The upserted rule
   */
  upsertRule(rule: Partial<AutomationRule> & { id: string }): Promise<AutomationRule>;

  /**
   * Delete an automation rule
   * @param id - The rule ID
   */
  deleteRule(id: string): Promise<void>;

  // ═══════════════════════════════════════════════════════════════
  // MODERATION LOGS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Add a moderation log entry
   * @param log - Log data without ID (will be generated)
   * @returns The created log entry
   */
  addModerationLog(log: Omit<ModerationLog, "id">): Promise<ModerationLog>;

  /**
   * Get moderation logs
   * @param memberId - Optional member ID to filter by
   * @param limit - Optional limit on number of results
   * @returns Array of log entries, newest first
   */
  getModerationLogs(memberId?: string, limit?: number): Promise<ModerationLog[]>;

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get analytics for a time period
   * @param start - ISO date string for period start
   * @param end - ISO date string for period end
   * @returns Analytics summary for the period
   */
  getAnalytics(start: string, end: string): Promise<VaultAnalytics>;

  // ═══════════════════════════════════════════════════════════════
  // SYNC (for composite stores)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Trigger sync with external data sources (e.g., Notion)
   * Optional - only implemented by composite stores
   */
  sync?(): Promise<void>;
}

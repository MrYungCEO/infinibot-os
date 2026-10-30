/**
 * Kingly Vault — Core Type Definitions
 * Modular course/community platform with Discord integration
 */

// ═══════════════════════════════════════════════════════════════
// LEARNING PATH TYPES
// ═══════════════════════════════════════════════════════════════

export interface LearningPathCourseRef {
  courseId: string;
  name: string;
  reason: string;
  order: number;
}

export interface LearningPathWeek {
  week: number;
  focus: string;
  courses: LearningPathCourseRef[];
}

export interface LearningPathOnboardingAnswers {
  interests: string[];
  goals: string[];
  skillLevel: "beginner" | "intermediate" | "advanced";
  hoursPerWeek: number;
  wantToLearn: string;
}

export interface LearningPath {
  id: string;
  memberId: string;
  generatedAt: string;
  answers: LearningPathOnboardingAnswers;
  weeks: LearningPathWeek[];
  totalWeeks: number;
  totalCourses: number;
  summary: string;
}

// ═══════════════════════════════════════════════════════════════
// MEMBER TYPES
// ═══════════════════════════════════════════════════════════════

export type MemberTier = "free" | "basic" | "paid" | "premium" | "vip" | "lifetime" | "admin";

export interface VaultMember {
  id: string;
  discordId?: string;
  discordUsername?: string;
  discordAvatar?: string;
  email?: string;
  name?: string;
  tier: MemberTier | string;
  roles?: string[]; // Discord role IDs

  // Status
  joinedAt: string | number; // ISO date or epoch ms
  lastActiveAt?: string | number;
  status: "active" | "inactive" | "banned" | "pending" | "warned" | "muted";

  // Payment info
  paymentSource?: "whop" | "stripe" | "manual" | "free";
  paymentId?: string;
  subscriptionStatus?: "active" | "cancelled" | "past_due" | "none";

  // Moderation
  warnings: (Warning | MemberWarningLegacy)[];
  currentTimeout?: MemberTimeoutLegacy;
  notes?: string; // Admin notes

  // Learning Path
  learningPath?: LearningPath | null;

  // Computed / Stats
  completedCourses?: number;
  totalProgress?: number; // 0-100

  // Legacy fields (used by store-legacy.ts)
  coursesEnrolled?: string[];
  coursesCompleted?: string[];
  totalLessonsCompleted?: number;
  streak?: number;
  lastStreakDate?: string;
  messagesCount?: number;
  reactionsCount?: number;
  helpfulAnswers?: number;
  tags?: string[];
  customData?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/** Legacy warning shape used by store-legacy */
export interface MemberWarningLegacy {
  id: string;
  reason: string;
  severity: "low" | "medium" | "high";
  issuedBy: string;
  issuedAt: number;
  expiresAt?: number;
}

/** Legacy timeout shape used by store-legacy */
export interface MemberTimeoutLegacy {
  reason: string;
  issuedBy: string;
  startedAt: number;
  expiresAt: number;
}

export interface Warning {
  id: string;
  memberId: string;
  reason: string;
  severity: "minor" | "moderate" | "severe";
  issuedBy: string;
  issuedAt: string;
  expiresAt?: string;
  resolved?: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface MemberFilters {
  tier?: MemberTier | MemberTier[];
  status?: "active" | "inactive" | "banned" | "pending";
  hasWarnings?: boolean;
  courseId?: string; // enrolled in course
  courseCompleted?: boolean;
  search?: string;
  discordRoleId?: string;
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════
// COURSE TYPES
// ═══════════════════════════════════════════════════════════════

export type CourseStatus = "draft" | "published" | "archived";
export type AccessLevel = "free" | "basic" | "paid" | "premium" | "vip" | "lifetime" | "admin";

export interface VaultCourse {
  id: string;
  name?: string;
  title?: string; // Legacy alias for name
  slug: string;
  description: string;
  coverImage?: string;
  thumbnailUrl?: string; // Legacy alias for coverImage
  status: CourseStatus | string;
  accessLevel?: AccessLevel;
  requiredTier?: MemberTier | string; // Legacy alias for accessLevel
  requiredRoles?: string[]; // Discord role IDs for access
  discordRoleId?: string; // Legacy field

  // Structure
  modules: VaultModule[];

  // Stats
  enrolledCount: number;
  completedCount?: number; // Legacy
  completionRate?: number;
  averageRating?: number;

  // Sort priority (lower = higher in list)
  sortOrder?: number;

  // Meta
  createdAt: string | number;
  updatedAt: string | number;
  publishedAt?: string | number;
  archivedAt?: Date; // Used by manager.ts

  // Legacy fields
  totalLessons?: number;
  estimatedHours?: number;
  instructorId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface VaultModule {
  id: string;
  courseId: string;
  name: string;
  description?: string;
  order: number;
  lessons: VaultLesson[];
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
}

export interface VaultLesson {
  id: string;
  moduleId: string;
  name: string;
  description?: string;
  order: number;
  type?: LessonContentType | "assignment" | "live"; // Extended lesson type
  contentType?: LessonContentType;
  content?: LessonContent | LessonContentExtended;
  duration?: number; // minutes
  durationMinutes?: number; // Alias
  required?: boolean; // New-style flag
  requiredForCompletion?: boolean; // Legacy flag
  unlockAfter?: string | string[]; // lesson ID(s)
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
}

/** Extended content shape used by courses module */
export interface LessonContentExtended {
  videoUrl?: string;
  videoProvider?: string;
  markdown?: string;
  quiz?: {
    questions: QuizQuestion[];
    passingScore: number;
    allowRetry?: boolean;
    showCorrectAnswers?: boolean;
  };
  assignment?: {
    instructions: string;
    submissionType: "text" | "file" | "url";
    rubric?: string;
  };
}

export type LessonContentType = "video" | "text" | "download" | "quiz" | "action" | "embed";

export type LessonContent =
  | {
      type: "video";
      url: string;
      provider: "youtube" | "vimeo" | "loom" | "wistia" | "custom";
      thumbnailUrl?: string;
    }
  | { type: "text"; markdown: string }
  | { type: "download"; files: { name: string; url: string; size?: number }[] }
  | { type: "quiz"; questions: QuizQuestion[]; passingScore: number }
  | {
      type: "action";
      task: string;
      verificationMethod: "manual" | "discord_role" | "link_click" | "form";
    }
  | { type: "embed"; html: string; provider?: string };

export interface QuizQuestion {
  id: string;
  question?: string;
  text?: string; // Alias for question
  type: "multiple_choice" | "multiple-choice" | "true_false" | "text";
  options?: string[];
  correctAnswer: string | number | string[];
  explanation?: string;
  points?: number;
}

// ═══════════════════════════════════════════════════════════════
// PROGRESS TYPES
// ═══════════════════════════════════════════════════════════════

export interface CourseProgress {
  id?: string;
  memberId: string;
  courseId: string;
  enrolledAt: string | number | Date;
  startedAt?: string | number | Date;
  lastAccessedAt?: string | number | Date;
  completedAt?: string | number | Date;
  lessonProgress: LessonProgress[];
  overallProgress: number; // 0-100
  quizScores?: { lessonId: string; score: number; attempts: number }[];
}

export interface LessonProgress {
  lessonId: string;
  status: "not_started" | "in_progress" | "in-progress" | "completed" | "locked" | "available";
  startedAt?: string | number | Date;
  completedAt?: string | number | Date;
  timeSpent?: number; // seconds
  quizAttempts?: QuizAttemptRecord[];
}

export interface QuizAttemptRecord {
  attemptId: string;
  answers: Record<string, string | string[]>;
  score: number;
  passed: boolean;
  attemptedAt: Date;
}

// ═══════════════════════════════════════════════════════════════
// DISCORD TYPES
// ═══════════════════════════════════════════════════════════════

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string;
  memberCount: number;
  channels: DiscordChannel[];
  roles: DiscordRole[];
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: "text" | "voice" | "category" | "forum" | "announcement";
  parentId?: string;
  position: number;
  topic?: string;
  permissions?: ChannelPermission[];
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  mentionable: boolean;
  managed?: boolean;
  hoist?: boolean;
  guildId?: string;
  icon?: string | null;
  memberCount?: number;
}

export interface ChannelPermission {
  roleId: string;
  allow: string[];
  deny: string[];
}

export interface DiscordMemberData {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string;
  roles: string[];
  joinedAt: string;
  nickname?: string;
}

// ═══════════════════════════════════════════════════════════════
// MODERATION TYPES
// ═══════════════════════════════════════════════════════════════

export type ModAction =
  | "warn"
  | "timeout"
  | "kick"
  | "ban"
  | "unban"
  | "clear_warnings"
  | "delete_message";

export interface ModerationLog {
  id: string;
  action: ModAction;
  targetMemberId: string;
  targetDiscordId?: string;
  performedBy: string; // 'ash' | admin user id
  reason: string;
  details?: Record<string, unknown>;
  timestamp: string;
  autoAction: boolean; // true if triggered by automation
  ruleId?: string; // if triggered by rule
}

export interface ModerationConfig {
  autoModEnabled: boolean;
  warnThresholds: {
    minorBeforeTimeout: number;
    moderateBeforeKick: number;
    severeBeforeBan: number;
  };
  timeoutDurations: {
    first: number; // minutes
    second: number;
    third: number;
  };
  blockedWords: string[];
  linkWhitelist: string[];
  spamDetection: {
    enabled: boolean;
    messageThreshold: number;
    timeWindowSeconds: number;
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTOMATION TYPES
// ═══════════════════════════════════════════════════════════════

export interface AutomationRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: RuleTrigger;
  triggerConfig?: Record<string, unknown>;
  conditions: RuleCondition[];
  actions: RuleAction[];
  createdAt: string | number;
  lastTriggeredAt?: string | number;
  triggerCount: number;
  updatedAt?: number;
}

export type RuleTrigger =
  | { type: "member_join" }
  | { type: "member_leave" }
  | { type: "payment_received"; tier?: string }
  | { type: "payment_cancelled" }
  | { type: "course_enroll"; courseId?: string }
  | { type: "course_complete"; courseId: string }
  | { type: "lesson_complete"; lessonId: string }
  | { type: "module_complete"; moduleId: string }
  | { type: "warning_issued"; severity?: Warning["severity"] }
  | { type: "warning_threshold"; count: number }
  | { type: "inactivity"; days: number }
  | { type: "discord_role_added"; roleId: string }
  | { type: "discord_role_removed"; roleId: string }
  | { type: "discord_message"; channelId?: string; contains?: string }
  | { type: "schedule"; cron: string };

export type RuleCondition =
  | { type: "member_tier"; tiers: MemberTier[] }
  | { type: "member_has_role"; roleId: string }
  | { type: "member_missing_role"; roleId: string }
  | { type: "course_completed"; courseId: string }
  | { type: "course_not_started"; courseId: string }
  | { type: "time_since_join"; days: number; comparison: "gt" | "lt" | "eq" }
  | { type: "warning_count"; count: number; comparison: "gt" | "lt" | "eq" }
  | { type: "custom"; expression: string };

export type RuleAction =
  | { type: "assign_role"; roleId: string }
  | { type: "remove_role"; roleId: string }
  | { type: "send_dm"; template: string; variables?: Record<string, string> }
  | {
      type: "send_channel";
      channelId: string;
      template: string;
      variables?: Record<string, string>;
    }
  | { type: "grant_course"; courseId: string }
  | { type: "revoke_course"; courseId: string }
  | { type: "update_tier"; tier: MemberTier }
  | { type: "issue_warning"; reason: string; severity: Warning["severity"] }
  | { type: "timeout_member"; durationMinutes: number; reason?: string }
  | { type: "kick_member"; reason?: string }
  | { type: "notify_admin"; message: string; channel?: "dm" | "channel"; channelId?: string }
  | { type: "webhook"; url: string; method?: "GET" | "POST"; payload?: object }
  | { type: "delay"; seconds: number }
  | { type: "add_note"; note: string };

// ═══════════════════════════════════════════════════════════════
// ANALYTICS TYPES
// ═══════════════════════════════════════════════════════════════

export type ActivityType =
  | "member_join"
  | "member_leave"
  | "course_complete"
  | "warning_issued"
  | "role_change"
  | "payment"
  | "message";

export interface VaultActivity {
  id: string;
  type: ActivityType;
  memberId?: string;
  memberName?: string;
  memberAvatar?: string;
  channelId?: string;
  channelName?: string;
  content?: string;
  description: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface VaultAnalytics {
  period: { start: string; end: string };
  members: {
    total: number;
    active: number;
    new: number;
    churned: number;
    byTier: Record<MemberTier, number>;
  };
  courses: {
    totalEnrollments: number;
    completions: number;
    averageProgress: number;
    topCourses: { courseId: string; name: string; enrollments: number; completionRate: number }[];
  };
  engagement: {
    dailyActiveUsers: number[];
    averageSessionDuration: number;
    lessonsCompleted: number;
    quizzesPassed: number;
  };
  moderation: {
    warnings: number;
    timeouts: number;
    kicks: number;
    bans: number;
  };
  revenue?: {
    total: number;
    bySource: Record<string, number>;
    mrr: number;
    newSubscriptions: number;
    cancellations: number;
  };
  // Activity feed (most recent events)
  recentActivity?: VaultActivity[];
  // UI aliases (for compatibility with dashboard view)
  totalMembers?: number;
  activeMembers?: number;
  newMembersThisWeek?: number;
  newMembersThisMonth?: number;
  totalCourses?: number;
  totalWarnings?: number;
  activeWarnings?: number;
  churnRate?: number;
  averageEngagement?: number;
  topCourses?: { id: string; title: string; enrollments: number }[];

  // ═══════════════════════════════════════════════════════════════
  // KinglyVault Extended Analytics (from user_engagement table)
  // ═══════════════════════════════════════════════════════════════

  // User metrics
  totalUsers?: number;
  totalRegisteredUsers?: number;
  totalActiveUsers?: number;

  // Session/page metrics
  totalSessions?: number;
  totalPageViews?: number;
  totalLogins?: number;

  // Course metrics
  totalCourseStarts?: number;
  totalCourseCompletions?: number;

  // Lesson metrics
  totalLessonStarts?: number;
  totalLessonViews?: number;
  totalLessonCompletions?: number;
  totalVideoPlays?: number;
  totalDownloads?: number;
  totalSearches?: number;

  // AI Chat metrics
  totalAiChatMessages?: number;
  totalAiChatConversations?: number;
  aiChatModeUsage?: Array<{ mode: string; messages: number; conversations: number }>;

  // Image Generation metrics
  totalImageGenerations?: number;
  totalImageGenerationSuccess?: number;
  totalImageGenerationFailed?: number;
  imageGenerationsByDay?: Array<{
    date: string;
    generations: number;
    success: number;
    failed: number;
  }>;

  // Engagement breakdown
  engagementByDay?: Array<{ date: string; events: number; users: number }>;
  userActivityBreakdown?: Array<{ eventType: string; count: number }>;

  // Tool engagement
  toolEngagement?: {
    totalToolViews: number;
    totalToolClicks: number;
    totalToolUsage: number;
    topTools: Array<{
      toolId: number;
      title: string;
      views: number;
      clicks: number;
      usage: number;
    }>;
    toolsByCategory: Array<{ category: string; count: number; usage: number }>;
    toolEngagementByDay: Array<{ date: string; views: number; clicks: number; usage: number }>;
  };

  // Vault/Agent engagement
  vaultEngagement?: {
    totalVaultViews: number;
    totalFileDownloads: number;
    totalFileUploads: number;
    totalAgentCreations: number;
    topAgents: Array<{
      agentId: string;
      name: string;
      views: number;
      downloads: number;
      usage: number;
    }>;
    vaultActivityByDay: Array<{ date: string; views: number; downloads: number; uploads: number }>;
    fileTypeBreakdown: Array<{ fileType: string; count: number; downloads: number }>;
  };
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION TYPES
// ═══════════════════════════════════════════════════════════════

export type DataSourceType = "sqlite" | "notion" | "composite";

export interface VaultConfig {
  // Data source
  dataSource?: DataSourceType;
  sqlite?: {
    path: string;
  };
  notion?: {
    enabled: boolean;
    apiKey?: string; // use env var if not set
    membersDbId?: string;
    coursesDbId?: string;
    syncInterval?: number; // seconds
  };

  // Discord (nested form)
  discord?: {
    guildId: string;
    botToken?: string; // use existing infinibot config if not set
    welcomeChannelId?: string;
    announcementChannelId?: string;
    modLogChannelId?: string;
    adminRoleId?: string;
    memberRoleId?: string;
  };

  // Legacy Discord fields (flat form, used by store-legacy.ts and discord.ts)
  guildId?: string;
  botToken?: string;
  tierRoles?: Record<string, string>;
  moderatorRoles?: string[];
  adminRoles?: string[];
  welcomeChannelId?: string;
  announcementChannelId?: string;
  modLogChannelId?: string;

  // Payments
  payments?: {
    whop?: {
      enabled: boolean;
      apiKey?: string;
      webhookSecret?: string;
      productMapping?: Record<string, MemberTier>; // whop product id -> tier
    };
    stripe?: {
      enabled: boolean;
      apiKey?: string;
      webhookSecret?: string;
      priceMapping?: Record<string, MemberTier>; // stripe price id -> tier
    };
  };

  // Infini autonomy
  ashAutonomy?: {
    level: 1 | 2 | 3; // 1=monitor, 2=moderate, 3=full
    requireApproval?: ModAction[] | string[];
    notifyOn?: ModAction[] | string[];
    notifyChannel?: "telegram" | "discord_dm" | "discord_channel";
    notifyChannelId?: string;
  };

  // Moderation
  moderation?: ModerationConfig;

  // Branding
  branding?: {
    name: string;
    logo?: string;
    primaryColor?: string;
    welcomeMessage?: string;
  };

  // Legacy fields
  features?: {
    autoModeration: boolean;
    progressTracking: boolean;
    streakTracking: boolean;
    automationRules: boolean;
    analytics: boolean;
  };
  updatedAt?: number;
}

// ═══════════════════════════════════════════════════════════════
// AGENT TOOL INTERFACE
// ═══════════════════════════════════════════════════════════════

export type VaultToolAction =
  // Moderation
  | "warn_member"
  | "timeout_member"
  | "kick_member"
  | "ban_member"
  | "unban_member"
  | "clear_warnings"
  | "delete_message"

  // Member management
  | "get_member"
  | "list_members"
  | "update_member"
  | "set_tier"
  | "add_note"
  | "sync_discord_member"

  // Course operations
  | "list_courses"
  | "get_course"
  | "create_course"
  | "update_course"
  | "publish_course"
  | "archive_course"
  | "grant_course_access"
  | "revoke_course_access"
  | "get_progress"

  // Discord control
  | "send_announcement"
  | "send_dm"
  | "create_channel"
  | "delete_channel"
  | "set_channel_permissions"
  | "assign_role"
  | "remove_role"
  | "get_guild_info"

  // Automation
  | "list_rules"
  | "get_rule"
  | "create_rule"
  | "update_rule"
  | "enable_rule"
  | "disable_rule"
  | "delete_rule"
  | "trigger_rule"

  // Analytics
  | "get_stats"
  | "engagement_report"
  | "revenue_report"
  | "moderation_report"

  // Config
  | "get_config"
  | "update_config";

export interface VaultToolParams {
  action: VaultToolAction;

  // Member params
  memberId?: string;
  discordId?: string;
  tier?: MemberTier;
  note?: string;
  search?: string;

  // Warning/mod params
  reason?: string;
  severity?: Warning["severity"];
  durationMinutes?: number;
  deleteDays?: number;

  // Course params
  courseId?: string;
  courseName?: string;
  courseDescription?: string;
  accessLevel?: AccessLevel;

  // Discord params
  channelId?: string;
  roleId?: string;
  message?: string;
  template?: string;

  // Rule params
  ruleId?: string;
  rule?: Partial<AutomationRule>;

  // Filter params
  filters?: MemberFilters;
  status?: CourseStatus;

  // Analytics params
  startDate?: string;
  endDate?: string;

  // Config params
  config?: Partial<VaultConfig>;
}

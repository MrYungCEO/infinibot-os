/**
 * Kingly Vault Types
 * Re-exports canonical types from store/types.ts
 * 
 * This file provides backward compatibility for imports from './types.js'
 * The canonical type definitions are in store/types.ts
 */

// Re-export all canonical types from store
export * from './store/types.js';

// ============================================================
// Additional Types for Store.ts (SQLite-backed)
// ============================================================

// These are simplified versions used by the legacy store.ts
// The canonical types in store/types.ts are more comprehensive

export type MemberStatus = 'active' | 'inactive' | 'warned' | 'muted' | 'banned';

export interface MemberWarning {
  id: string;
  reason: string;
  severity: 'low' | 'medium' | 'high';
  issuedBy: string;
  issuedAt: number;
  expiresAt?: number;
}

export interface MemberTimeout {
  reason: string;
  issuedBy: string;
  startedAt: number;
  expiresAt: number;
}

// Re-map for store.ts compatibility
export interface VaultMemberLegacy {
  id: string;
  discordId: string;
  discordUsername: string;
  email?: string;
  tier: string;
  status: MemberStatus;
  joinedAt: number;
  lastActiveAt?: number;
  coursesEnrolled: string[];
  coursesCompleted: string[];
  totalLessonsCompleted: number;
  streak: number;
  lastStreakDate?: string;
  messagesCount: number;
  reactionsCount: number;
  helpfulAnswers: number;
  warnings: MemberWarning[];
  currentTimeout?: MemberTimeout;
  notes?: string;
  tags?: string[];
  customData?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// Legacy course module type for store.ts
export interface CourseModule {
  id: string;
  title: string;
  description?: string;
  order: number;
  lessons: Lesson[];
}

export interface Lesson {
  id: string;
  title: string;
  description?: string;
  type: 'video' | 'text' | 'quiz' | 'assignment' | 'live';
  contentUrl?: string;
  durationMinutes?: number;
  order: number;
  requiredForCompletion: boolean;
}

// Legacy progress type for store.ts
export interface LessonProgressLegacy {
  lessonId: string;
  completedAt?: number;
  watchedSeconds?: number;
  quizScore?: number;
  attempts?: number;
}

export interface MemberCourseProgress {
  memberId: string;
  courseId: string;
  enrolledAt: number;
  lessonsCompleted: string[];
  currentLessonId?: string;
  progressPercent: number;
  lessonProgress: LessonProgressLegacy[];
  completedAt?: number;
  certificateId?: string;
  updatedAt: number;
}

// Legacy rule types for store.ts
export type RuleTrigger = 
  | 'member_join'
  | 'member_leave'
  | 'tier_upgrade'
  | 'tier_downgrade'
  | 'course_complete'
  | 'lesson_complete'
  | 'streak_milestone'
  | 'warning_issued'
  | 'inactivity'
  | 'scheduled'
  | 'manual';

export type RuleAction =
  | 'assign_role'
  | 'remove_role'
  | 'send_dm'
  | 'send_channel'
  | 'add_to_course'
  | 'update_tier'
  | 'add_tag'
  | 'remove_tag'
  | 'webhook'
  | 'notify_admin';

export interface RuleCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'not_contains';
  value: string | number | boolean;
}

export interface AutomationRuleLegacy {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: RuleTrigger;
  triggerConfig?: Record<string, unknown>;
  conditions: RuleCondition[];
  actions: Array<{
    type: RuleAction;
    config: Record<string, unknown>;
  }>;
  lastTriggeredAt?: number;
  triggerCount: number;
  createdAt: number;
  updatedAt: number;
}

// Legacy config for store.ts compatibility
export interface VaultConfigLegacy {
  guildId: string;
  botToken?: string;
  tierRoles: Record<string, string>;
  moderatorRoles: string[];
  adminRoles: string[];
  welcomeChannelId?: string;
  announcementChannelId?: string;
  modLogChannelId?: string;
  features: {
    autoModeration: boolean;
    progressTracking: boolean;
    streakTracking: boolean;
    automationRules: boolean;
    analytics: boolean;
  };
  ashAutonomy: {
    level: 1 | 2 | 3;
    requireApproval: string[];
    notifyOn: string[];
  };
  updatedAt: number;
}

// Legacy analytics for store.ts
export interface VaultAnalyticsLegacy {
  period: 'day' | 'week' | 'month' | 'all';
  timestamp: number;
  totalMembers: number;
  newMembers: number;
  activeMembers: number;
  churnedMembers: number;
  membersByTier: Record<string, number>;
  totalEnrollments: number;
  totalCompletions: number;
  averageCompletionRate: number;
  courseStats: Array<{
    courseId: string;
    courseName: string;
    enrollments: number;
    completions: number;
    averageProgress: number;
  }>;
  totalMessages: number;
  totalReactions: number;
  topContributors: Array<{
    memberId: string;
    username: string;
    score: number;
  }>;
  warningsIssued: number;
  timeoutsIssued: number;
  bansIssued: number;
}

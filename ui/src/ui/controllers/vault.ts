/**
 * Kingly Vault Controller — Community management state and gateway operations
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Types ────────────────────────────────────────────────────

export interface VaultMember {
  id: string;
  discordId: string;
  username: string;
  discriminator?: string;
  avatar?: string;
  email?: string;
  joinedAt: string;
  roles: string[];
  tier: string;
  status: 'active' | 'inactive' | 'warned' | 'suspended' | 'banned';
  warningCount: number;
  lastActive?: string;
  engagementScore: number;
  coursesCompleted: number;
  coursesInProgress: number;
  notes?: string;
}

export interface VaultCourse {
  id: string;
  title: string;
  description: string;
  coverImage?: string;
  tier: string;
  status: 'draft' | 'published' | 'archived';
  modules: VaultModule[];
  enrollmentCount: number;
  completionRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface VaultModule {
  id: string;
  courseId: string;
  title: string;
  description: string;
  order: number;
  lessons: VaultLesson[];
}

export interface VaultLesson {
  id: string;
  moduleId: string;
  title: string;
  content: string;
  contentType: 'text' | 'video' | 'quiz' | 'assignment';
  videoUrl?: string;
  order: number;
  duration?: number; // minutes
}

export interface AutomationRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  priority: number;
  createdAt: string;
  updatedAt: string;
  lastTriggered?: string;
  triggerCount: number;
}

export interface AutomationTrigger {
  type: 'member_join' | 'member_leave' | 'role_change' | 'course_complete' | 'warning_issued' | 'payment_received' | 'message_sent' | 'scheduled';
  config: Record<string, unknown>;
}

export interface AutomationCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'in' | 'not_in';
  value: unknown;
}

export interface AutomationAction {
  type: 'assign_role' | 'remove_role' | 'send_dm' | 'send_channel_message' | 'grant_course_access' | 'revoke_course_access' | 'issue_warning' | 'kick' | 'ban' | 'webhook';
  config: Record<string, unknown>;
}

export interface VaultAnalytics {
  totalMembers: number;
  activeMembers: number;
  newMembersThisWeek: number;
  newMembersThisMonth: number;
  churnRate: number;
  retentionRate: number;
  totalWarnings: number;
  activeWarnings: number;
  totalCourses: number;
  totalEnrollments: number;
  averageEngagement: number;
  revenueThisMonth?: number;
  memberGrowth: { date: string; count: number }[];
  engagementTrend: { date: string; score: number }[];
  topCourses: { id: string; title: string; enrollments: number }[];
  recentActivity: VaultActivity[];
}

export interface VaultActivity {
  id: string;
  type: 'member_join' | 'member_leave' | 'course_complete' | 'warning_issued' | 'role_change' | 'payment' | 'message';
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

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string;
  memberCount: number;
  roles: DiscordRole[];
  channels: DiscordChannel[];
  emojis: { id: string; name: string; animated: boolean }[];
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
  memberCount?: number;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number; // 0=text, 2=voice, 4=category
  parentId?: string;
  position: number;
  topic?: string;
  nsfw?: boolean;
}

export interface VaultConfig {
  guildId: string;
  welcomeChannelId?: string;
  announcementChannelId?: string;
  modLogChannelId?: string;
  defaultRole?: string;
  tierRoles: Record<string, string>; // tier -> roleId
  autoModEnabled: boolean;
  warningThresholds: {
    warnAt: number;
    muteAt: number;
    kickAt: number;
    banAt: number;
  };
  courseAccessRoles: Record<string, string[]>; // courseId -> roleIds
}

export interface MemberFilters {
  search?: string;
  status?: string;
  tier?: string;
  role?: string;
  minEngagement?: number;
  hasWarnings?: boolean;
  sortBy?: 'username' | 'joinedAt' | 'lastActive' | 'engagementScore' | 'warningCount';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ModerationLog {
  id: string;
  memberId: string;
  memberName: string;
  moderatorId?: string;
  moderatorName?: string;
  action: 'warning' | 'mute' | 'kick' | 'ban' | 'unban' | 'unmute' | 'note';
  reason: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

// ── State Interface ──────────────────────────────────────────

export interface VaultState {
  loading: boolean;
  error: string | null;
  successMessage: string | null;
  
  // Data
  members: VaultMember[];
  courses: VaultCourse[];
  rules: AutomationRule[];
  analytics: VaultAnalytics | null;
  discordGuild: DiscordGuild | null;
  config: VaultConfig | null;
  moderationLogs: ModerationLog[];
  
  // UI state
  activeTab: 'overview' | 'members' | 'courses' | 'discord' | 'moderation' | 'automation' | 'analytics' | 'setup';
  selectedMember: VaultMember | null;
  selectedCourse: VaultCourse | null;
  selectedRule: AutomationRule | null;
  filters: MemberFilters;
  
  // Modals
  showMemberModal: boolean;
  showCourseModal: boolean;
  showRuleModal: boolean;
  showWarnModal: boolean;
  showAnnounceModal: boolean;
  
  // Form states
  warnForm: { memberId: string; reason: string; severity: string };
  announceForm: { title: string; content: string; channelId: string };
  courseForm: Partial<VaultCourse>;
  ruleForm: Partial<AutomationRule>;
  
  // Pagination
  membersPage: number;
  membersTotal: number;
  
  // Connected
  isConnected: boolean;
}

// ── Initial State ────────────────────────────────────────────

export function createVaultState(): VaultState {
  return {
    loading: false,
    error: null,
    successMessage: null,
    
    members: [],
    courses: [],
    rules: [],
    analytics: null,
    discordGuild: null,
    config: null,
    moderationLogs: [],
    
    activeTab: 'overview',
    selectedMember: null,
    selectedCourse: null,
    selectedRule: null,
    filters: { sortBy: 'joinedAt', sortOrder: 'desc', limit: 50, offset: 0 },
    
    showMemberModal: false,
    showCourseModal: false,
    showRuleModal: false,
    showWarnModal: false,
    showAnnounceModal: false,
    
    warnForm: { memberId: '', reason: '', severity: 'low' },
    announceForm: { title: '', content: '', channelId: '' },
    courseForm: {},
    ruleForm: {},
    
    membersPage: 0,
    membersTotal: 0,
    
    isConnected: false,
  };
}

// ── Gateway Operations ───────────────────────────────────────

export async function loadVaultData(gw: GatewayBrowserClient): Promise<Partial<VaultState>> {
  try {
    const [analyticsRes, configRes, guild, rolesRes, channelsRes] = await Promise.all([
      gw.request<{ analytics: VaultAnalytics }>('vault.analytics.get').catch(() => null),
      gw.request<{ config: VaultConfig }>('vault.config.get').catch(() => null),
      gw.request<DiscordGuild>('vault.discord.guild').catch(() => null),
      gw.request<{ roles: DiscordRole[] }>('vault.discord.roles.list').catch(() => null),
      gw.request<{ channels: DiscordChannel[] }>('vault.discord.channels.list').catch(() => null),
    ]);
    
    // Unwrap the nested responses from gateway
    let analytics = analyticsRes?.analytics ?? null;
    const config = configRes?.config ?? null;
    
    // Merge roles and channels into guild object
    const discordGuild = guild ? {
      ...guild,
      roles: rolesRes?.roles ?? [],
      channels: channelsRes?.channels ?? [],
    } : null;
    
    // If we have channels, try to fetch recent messages from the first text channel
    if (analytics && discordGuild?.channels?.length) {
      const textChannels = discordGuild.channels.filter(c => c.type === 0);
      if (textChannels.length > 0) {
        try {
          // Fetch recent messages from up to 3 channels
          const messagePromises = textChannels.slice(0, 3).map(ch => 
            gw.request<{ messages: VaultActivity[] }>('vault.discord.messages.recent', { 
              channelId: ch.id, 
              channelName: ch.name,
              limit: 10 
            }).catch(() => null)
          );
          
          const messageResults = await Promise.all(messagePromises);
          const allMessages: VaultActivity[] = [];
          
          for (const res of messageResults) {
            if (res?.messages) {
              allMessages.push(...res.messages);
            }
          }
          
          // Sort by timestamp descending and take top 15
          allMessages.sort((a, b) => 
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          
          // Merge with existing activity
          const existingActivity = analytics.recentActivity ?? [];
          analytics = {
            ...analytics,
            recentActivity: [...allMessages.slice(0, 15), ...existingActivity].slice(0, 20),
          };
        } catch (err) {
          console.warn('[Vault] Failed to fetch recent messages:', err);
        }
      }
    }
    
    return {
      analytics,
      config,
      discordGuild,
      isConnected: true,
      error: null,
    };
  } catch (err: any) {
    return {
      error: `Failed to load vault data: ${err.message}`,
      isConnected: false,
    };
  }
}

export async function loadMembers(
  gw: GatewayBrowserClient,
  filters?: MemberFilters
): Promise<{ members: VaultMember[]; total: number }> {
  try {
    const result = await gw.request<{ members: VaultMember[]; total: number }>(
      'vault.members.list',
      filters || {}
    );
    return result || { members: [], total: 0 };
  } catch (err: any) {
    console.error('[Vault] Failed to load members:', err);
    return { members: [], total: 0 };
  }
}

export async function getMember(gw: GatewayBrowserClient, memberId: string): Promise<VaultMember | null> {
  try {
    const res = await gw.request<{ member: VaultMember }>('vault.members.get', { id: memberId });
    return res?.member ?? null;
  } catch {
    return null;
  }
}

export async function updateMember(
  gw: GatewayBrowserClient,
  memberId: string,
  patch: Partial<VaultMember>
): Promise<void> {
  await gw.request('vault.members.update', { id: memberId, ...patch });
}

export async function warnMember(
  gw: GatewayBrowserClient,
  memberId: string,
  reason: string,
  severity: string
): Promise<void> {
  await gw.request('vault.members.warn', { memberId, reason, severity });
}

export async function kickMember(gw: GatewayBrowserClient, memberId: string, reason?: string): Promise<void> {
  await gw.request('vault.members.kick', { memberId, reason });
}

export async function banMember(gw: GatewayBrowserClient, memberId: string, reason?: string, days?: number): Promise<void> {
  // Gateway param is `deleteMessageDays` (number of days of messages to purge).
  await gw.request('vault.members.ban', { memberId, reason, deleteMessageDays: days });
}

export async function unbanMember(gw: GatewayBrowserClient, memberId: string): Promise<void> {
  await gw.request('vault.members.unban', { memberId });
}

export async function clearWarnings(gw: GatewayBrowserClient, memberId: string): Promise<void> {
  await gw.request('vault.moderation.clearWarnings', { memberId });
}

// ── Courses ──────────────────────────────────────────────────

export async function loadCourses(gw: GatewayBrowserClient): Promise<VaultCourse[]> {
  try {
    const result = await gw.request<{ courses: VaultCourse[], count: number }>('vault.courses.list');
    // Ensure we always return an array
    return Array.isArray(result?.courses) ? result.courses : [];
  } catch {
    return [];
  }
}

export async function getCourse(gw: GatewayBrowserClient, courseId: string): Promise<VaultCourse | null> {
  try {
    const res = await gw.request<{ course: VaultCourse }>('vault.courses.get', { id: courseId });
    return res?.course ?? null;
  } catch {
    return null;
  }
}

export async function createCourse(gw: GatewayBrowserClient, course: Partial<VaultCourse>): Promise<VaultCourse> {
  const res = await gw.request<{ course: VaultCourse }>('vault.courses.create', course);
  return res.course;
}

export async function updateCourse(gw: GatewayBrowserClient, courseId: string, patch: Partial<VaultCourse>): Promise<void> {
  await gw.request('vault.courses.update', { id: courseId, ...patch });
}

export async function deleteCourse(gw: GatewayBrowserClient, courseId: string): Promise<void> {
  await gw.request('vault.courses.delete', { id: courseId });
}

export async function publishCourse(gw: GatewayBrowserClient, courseId: string): Promise<void> {
  await gw.request('vault.courses.publish', { id: courseId });
}

export async function archiveCourse(gw: GatewayBrowserClient, courseId: string): Promise<void> {
  await gw.request('vault.courses.archive', { id: courseId });
}

// ── Modules & Lessons ────────────────────────────────────────

export async function createModule(
  gw: GatewayBrowserClient,
  courseId: string,
  module: Partial<VaultModule>
): Promise<VaultModule> {
  return await gw.request<VaultModule>('vault.modules.create', { courseId, ...module });
}

export async function updateModule(
  gw: GatewayBrowserClient,
  moduleId: string,
  patch: Partial<VaultModule>
): Promise<void> {
  await gw.request('vault.modules.update', { id: moduleId, ...patch });
}

export async function deleteModule(gw: GatewayBrowserClient, moduleId: string): Promise<void> {
  await gw.request('vault.modules.delete', { id: moduleId });
}

export async function createLesson(
  gw: GatewayBrowserClient,
  moduleId: string,
  lesson: Partial<VaultLesson>
): Promise<VaultLesson> {
  return await gw.request<VaultLesson>('vault.lessons.create', { moduleId, ...lesson });
}

export async function updateLesson(
  gw: GatewayBrowserClient,
  lessonId: string,
  patch: Partial<VaultLesson>
): Promise<void> {
  await gw.request('vault.lessons.update', { id: lessonId, ...patch });
}

export async function deleteLesson(gw: GatewayBrowserClient, lessonId: string): Promise<void> {
  await gw.request('vault.lessons.delete', { id: lessonId });
}

// ── Automation Rules ─────────────────────────────────────────

export async function loadRules(gw: GatewayBrowserClient): Promise<AutomationRule[]> {
  try {
    const result = await gw.request<{ rules: AutomationRule[]; count: number }>('vault.rules.list');
    return result?.rules ?? [];
  } catch {
    return [];
  }
}

export async function createRule(gw: GatewayBrowserClient, rule: Partial<AutomationRule>): Promise<AutomationRule> {
  const res = await gw.request<{ rule: AutomationRule }>('vault.rules.create', rule);
  return res.rule;
}

export async function updateRule(gw: GatewayBrowserClient, ruleId: string, patch: Partial<AutomationRule>): Promise<void> {
  await gw.request('vault.rules.update', { id: ruleId, ...patch });
}

export async function deleteRule(gw: GatewayBrowserClient, ruleId: string): Promise<void> {
  await gw.request('vault.rules.delete', { id: ruleId });
}

export async function toggleRule(gw: GatewayBrowserClient, ruleId: string, enabled: boolean): Promise<void> {
  // Enable/disable is just a partial rule update — vault.rules.update applies
  // only the fields present in params.
  await gw.request('vault.rules.update', { id: ruleId, enabled });
}

export async function testRule(gw: GatewayBrowserClient, ruleId: string): Promise<{ success: boolean; result?: unknown }> {
  return await gw.request('vault.rules.test', { id: ruleId });
}

// ── Discord ──────────────────────────────────────────────────

export async function loadDiscordGuild(gw: GatewayBrowserClient): Promise<DiscordGuild | null> {
  try {
    return await gw.request<DiscordGuild>('vault.discord.guild');
  } catch {
    return null;
  }
}

export async function assignRole(gw: GatewayBrowserClient, memberId: string, roleId: string): Promise<void> {
  // The handler resolves `memberId` (a vault member id) to its Discord id.
  await gw.request('vault.discord.roles.assign', { memberId, roleId });
}

export async function removeRole(gw: GatewayBrowserClient, memberId: string, roleId: string): Promise<void> {
  await gw.request('vault.discord.roles.remove', { memberId, roleId });
}

export async function sendAnnouncement(
  gw: GatewayBrowserClient,
  channelId: string,
  content: string,
  embed?: Record<string, unknown>
): Promise<void> {
  // vault.discord.send posts to a channel; its message param is `message`.
  // Embeds are not part of the served shape, so a caller passing one gets a
  // plain-text post rather than a silent failure.
  await gw.request('vault.discord.send', { channelId, message: content, embed });
}

export async function sendDirectMessage(
  gw: GatewayBrowserClient,
  memberId: string,
  content: string
): Promise<void> {
  await gw.request('vault.discord.dm', { memberId, message: content });
}

// ── Moderation Logs ──────────────────────────────────────────

export async function loadModerationLogs(
  gw: GatewayBrowserClient,
  memberId?: string,
  limit?: number
): Promise<ModerationLog[]> {
  try {
    const result = await gw.request<{ logs: ModerationLog[]; count: number }>(
      'vault.moderation.logs',
      { memberId, limit }
    );
    return result?.logs ?? [];
  } catch {
    return [];
  }
}

// ── Analytics ────────────────────────────────────────────────

export async function loadAnalytics(gw: GatewayBrowserClient): Promise<VaultAnalytics | null> {
  try {
    const res = await gw.request<{ analytics: VaultAnalytics }>('vault.analytics.get');
    return res?.analytics ?? null;
  } catch {
    return null;
  }
}

export async function exportAnalytics(gw: GatewayBrowserClient, format: 'csv' | 'json'): Promise<string> {
  const res = await gw.request<{ content: string }>('vault.analytics.export', { format });
  return res?.content ?? '';
}

// ── Config ───────────────────────────────────────────────────

export async function loadConfig(gw: GatewayBrowserClient): Promise<VaultConfig | null> {
  try {
    // vault.config.get answers `{ config }` (bot token redacted).
    const res = await gw.request<{ config: VaultConfig | null }>('vault.config.get');
    return res?.config ?? null;
  } catch {
    return null;
  }
}

export async function saveConfig(gw: GatewayBrowserClient, config: Partial<VaultConfig>): Promise<void> {
  // vault.config.update takes the patch nested under `config`.
  await gw.request('vault.config.update', { config });
}

// ── Setup Wizard ─────────────────────────────────────────────

export interface SetupWizardStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  required: boolean;
}

export async function getSetupStatus(gw: GatewayBrowserClient): Promise<{
  completed: boolean;
  steps: SetupWizardStep[];
}> {
  try {
    return await gw.request('vault.setup.status');
  } catch {
    return {
      completed: false,
      steps: [
        { id: 'discord', title: 'Connect Discord', description: 'Link your Discord server', completed: false, required: true },
        { id: 'roles', title: 'Configure Roles', description: 'Set up membership tiers', completed: false, required: true },
        { id: 'channels', title: 'Set Channels', description: 'Configure announcement channels', completed: false, required: false },
        { id: 'welcome', title: 'Welcome Message', description: 'Customize member greeting', completed: false, required: false },
        { id: 'courses', title: 'Create First Course', description: 'Add your first course', completed: false, required: false },
      ],
    };
  }
}

export async function completeSetupStep(gw: GatewayBrowserClient, stepId: string, data?: Record<string, unknown>): Promise<void> {
  await gw.request('vault.setup.complete', { stepId, data });
}

// ── Polling ──────────────────────────────────────────────────

let vaultPollTimer: ReturnType<typeof setInterval> | null = null;

export function startVaultPolling(
  gw: GatewayBrowserClient,
  onUpdate: (data: Partial<VaultState>) => void
): void {
  if (vaultPollTimer) return;
  
  vaultPollTimer = setInterval(async () => {
    try {
      const analytics = await loadAnalytics(gw);
      if (analytics) {
        onUpdate({ analytics });
      }
    } catch {
      // Silently ignore poll failures
    }
  }, 30000); // Poll every 30s
}

export function stopVaultPolling(): void {
  if (vaultPollTimer) {
    clearInterval(vaultPollTimer);
    vaultPollTimer = null;
  }
}

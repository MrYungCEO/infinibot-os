/**
 * Community Discord Integration Types
 * 
 * Types for community-focused Discord integration including:
 * - Role ↔ Tier mapping
 * - Slash commands
 * - Webhooks and events
 * - Analytics
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface CommunityConfig {
  guildId: string;
  botToken?: string;
  
  // Channels
  welcomeChannelId?: string;
  announcementChannelId?: string;
  supportChannelId?: string;
  coursesChannelId?: string;
  
  // Role mappings
  roleMapping: TierRoleMapping;
  
  // Features
  features: {
    autoRoleSync: boolean;
    welcomeMessages: boolean;
    progressAnnouncements: boolean;
    slashCommands: boolean;
    webhooks: boolean;
    analytics: boolean;
  };
  
  // Verification
  verification?: {
    enabled: boolean;
    verifiedRoleId?: string;
    pendingRoleId?: string;
    requireEmail?: boolean;
  };
  
  // Webhooks
  webhooks?: WebhookConfig;
}

export interface TierRoleMapping {
  free?: string;       // Role ID for free tier
  basic?: string;      // Role ID for basic tier
  premium?: string;    // Role ID for premium tier
  vip?: string;        // Role ID for VIP tier
  lifetime?: string;   // Role ID for lifetime tier
  admin?: string;      // Role ID for admin tier
  [tier: string]: string | undefined;  // Custom tiers
}

export interface WebhookConfig {
  memberJoin?: {
    url: string;
    enabled: boolean;
    template?: string;
  };
  memberLeave?: {
    url: string;
    enabled: boolean;
    template?: string;
  };
  courseCompletion?: {
    url: string;
    enabled: boolean;
    template?: string;
  };
  newContent?: {
    url: string;
    enabled: boolean;
    template?: string;
  };
  tierChange?: {
    url: string;
    enabled: boolean;
    template?: string;
  };
}

// ============================================================================
// Member Types
// ============================================================================

export type MemberTier = 'free' | 'basic' | 'premium' | 'vip' | 'lifetime' | 'admin';

export interface CommunityMember {
  id: string;
  discordId: string;
  discordUsername: string;
  email?: string;
  tier: MemberTier | string;
  verified: boolean;
  verifiedAt?: string;
  verificationCode?: string;
  roles: string[];
  joinedAt: string;
  lastActiveAt?: string;
  
  // Course progress
  enrolledCourses: string[];
  completedCourses: string[];
  totalProgress: number;
  
  // Engagement
  messagesCount: number;
  reactionsCount: number;
  helpfulAnswers: number;
  streak: number;
  
  // Metadata
  customData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Slash Command Types
// ============================================================================

export interface SlashCommand {
  name: string;
  description: string;
  options?: SlashCommandOption[];
  defaultMemberPermissions?: string;
  dmPermission?: boolean;
}

export interface SlashCommandOption {
  type: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  name: string;
  description: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  options?: SlashCommandOption[];
  channelTypes?: number[];
  minValue?: number;
  maxValue?: number;
  minLength?: number;
  maxLength?: number;
  autocomplete?: boolean;
}

export interface SlashCommandInteraction {
  id: string;
  applicationId: string;
  type: 2; // APPLICATION_COMMAND
  data: {
    id: string;
    name: string;
    options?: Array<{
      name: string;
      type: number;
      value?: string | number | boolean;
      options?: SlashCommandInteraction['data']['options'];
      focused?: boolean;
    }>;
    resolved?: {
      users?: Record<string, unknown>;
      members?: Record<string, unknown>;
      roles?: Record<string, unknown>;
      channels?: Record<string, unknown>;
    };
  };
  guildId?: string;
  channelId: string;
  member?: {
    user: {
      id: string;
      username: string;
      discriminator?: string;
      avatar?: string;
    };
    roles: string[];
    nick?: string;
  };
  user?: {
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string;
  };
  token: string;
}

export interface InteractionResponse {
  type: 1 | 4 | 5 | 6 | 7 | 8 | 9;
  data?: {
    tts?: boolean;
    content?: string;
    embeds?: MessageEmbed[];
    allowedMentions?: {
      parse?: string[];
      roles?: string[];
      users?: string[];
      repliedUser?: boolean;
    };
    flags?: number;
    components?: MessageComponent[];
    attachments?: MessageAttachment[];
  };
}

// ============================================================================
// Webhook Event Types
// ============================================================================

export type WebhookEventType = 
  | 'member_join'
  | 'member_leave'
  | 'member_verified'
  | 'tier_change'
  | 'course_enrolled'
  | 'course_completed'
  | 'lesson_completed'
  | 'new_content'
  | 'support_ticket';

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  guildId: string;
  data: WebhookEventData;
}

export type WebhookEventData = 
  | MemberJoinEvent
  | MemberLeaveEvent
  | MemberVerifiedEvent
  | TierChangeEvent
  | CourseEnrolledEvent
  | CourseCompletedEvent
  | LessonCompletedEvent
  | NewContentEvent
  | SupportTicketEvent;

export interface MemberJoinEvent {
  memberId: string;
  discordId: string;
  username: string;
  tier: string;
}

export interface MemberLeaveEvent {
  memberId: string;
  discordId: string;
  username: string;
  reason?: string;
}

export interface MemberVerifiedEvent {
  memberId: string;
  discordId: string;
  username: string;
  email?: string;
}

export interface TierChangeEvent {
  memberId: string;
  discordId: string;
  username: string;
  previousTier: string;
  newTier: string;
  source?: 'manual' | 'payment' | 'automation';
}

export interface CourseEnrolledEvent {
  memberId: string;
  discordId: string;
  username: string;
  courseId: string;
  courseName: string;
}

export interface CourseCompletedEvent {
  memberId: string;
  discordId: string;
  username: string;
  courseId: string;
  courseName: string;
  completionTime: number; // seconds
}

export interface LessonCompletedEvent {
  memberId: string;
  discordId: string;
  username: string;
  courseId: string;
  courseName: string;
  lessonId: string;
  lessonName: string;
  progress: number; // 0-100
}

export interface NewContentEvent {
  contentType: 'course' | 'lesson' | 'resource';
  contentId: string;
  contentName: string;
  description?: string;
  addedBy?: string;
}

export interface SupportTicketEvent {
  ticketId: string;
  memberId: string;
  discordId: string;
  username: string;
  category: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  subject: string;
  description: string;
}

// ============================================================================
// Analytics Types
// ============================================================================

export interface CommunityAnalytics {
  period: {
    start: string;
    end: string;
  };
  
  // Discord engagement
  discord: {
    totalMembers: number;
    activeMembers: number;
    newMembers: number;
    leftMembers: number;
    verifiedMembers: number;
    
    // Activity
    totalMessages: number;
    totalReactions: number;
    activeChannels: ChannelActivity[];
    peakHours: Array<{ hour: number; activity: number }>;
    
    // Voice
    voiceMinutes: number;
    voiceParticipants: number;
  };
  
  // Member engagement
  members: {
    byTier: Record<string, number>;
    averageStreak: number;
    topContributors: Array<{
      memberId: string;
      username: string;
      score: number;
      messages: number;
      helpful: number;
    }>;
  };
  
  // Course engagement
  courses: {
    totalEnrollments: number;
    totalCompletions: number;
    averageProgress: number;
    popularCourses: Array<{
      courseId: string;
      courseName: string;
      enrollments: number;
      completions: number;
    }>;
  };
}

export interface ChannelActivity {
  channelId: string;
  channelName: string;
  messages: number;
  uniqueUsers: number;
}

// ============================================================================
// Message Types (for embeds and components)
// ============================================================================

export interface MessageEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface MessageComponent {
  type: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  components?: MessageComponent[];
  style?: 1 | 2 | 3 | 4 | 5;
  label?: string;
  emoji?: { name?: string; id?: string; animated?: boolean };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
  options?: SelectOption[];
  placeholder?: string;
  min_values?: number;
  max_values?: number;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: { name?: string; id?: string; animated?: boolean };
  default?: boolean;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  description?: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url?: string;
  height?: number;
  width?: number;
}

// ============================================================================
// Gateway Method Types
// ============================================================================

export interface ConnectParams {
  guildId: string;
  botToken?: string;
  roleMapping?: TierRoleMapping;
}

export interface ConnectResult {
  connected: boolean;
  guildId: string;
  guildName: string;
  memberCount: number;
  commandsRegistered: number;
}

export interface SyncParams {
  fullSync?: boolean;
  syncRoles?: boolean;
  syncMembers?: boolean;
}

export interface SyncResult {
  synced: boolean;
  membersUpdated: number;
  rolesUpdated: number;
  errors: string[];
}

export interface RolesMapParams {
  mapping: TierRoleMapping;
}

export interface RolesMapResult {
  mapped: boolean;
  tierCount: number;
}

export interface SendParams {
  channelId: string;
  message: string;
  embed?: MessageEmbed;
  components?: MessageComponent[];
}

export interface SendResult {
  sent: boolean;
  messageId: string;
}

// ============================================================================
// Support Ticket Types
// ============================================================================

export interface SupportTicket {
  id: string;
  memberId: string;
  discordId: string;
  channelId?: string;
  threadId?: string;
  category: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
  subject: string;
  description: string;
  assignedTo?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  closedAt?: string;
  messages: TicketMessage[];
}

export interface TicketMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  isStaff: boolean;
  timestamp: string;
}

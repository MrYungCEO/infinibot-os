/**
 * Community Module
 * 
 * Community management system with Discord integration for:
 * - Member management with tier-based roles
 * - Slash commands for member interaction
 * - Support ticket system
 * - Webhooks for event notifications
 * - Analytics tracking
 * 
 * @module community
 */

// ============================================================================
// Discord Integration (Main Export)
// ============================================================================

export {
  CommunityDiscordIntegration,
  createCommunityDiscordIntegration,
  DiscordIntegrationError,
} from "./discord-integration.js";

// ============================================================================
// Gateway Handlers
// ============================================================================

export { communityDiscordHandlers } from "./gateway-handlers.js";

// ============================================================================
// Types
// ============================================================================

export type {
  // Configuration
  CommunityConfig,
  TierRoleMapping,
  WebhookConfig,
  
  // Member
  MemberTier,
  CommunityMember,
  
  // Commands
  SlashCommand,
  SlashCommandOption,
  SlashCommandInteraction,
  InteractionResponse,
  
  // Webhooks
  WebhookEventType,
  WebhookEvent,
  WebhookEventData,
  MemberJoinEvent,
  MemberLeaveEvent,
  MemberVerifiedEvent,
  TierChangeEvent,
  CourseEnrolledEvent,
  CourseCompletedEvent,
  LessonCompletedEvent,
  NewContentEvent,
  SupportTicketEvent,
  
  // Analytics
  CommunityAnalytics,
  ChannelActivity,
  
  // Messages
  MessageEmbed,
  MessageComponent,
  SelectOption,
  MessageAttachment,
  
  // Gateway Params/Results
  ConnectParams,
  ConnectResult,
  SyncParams,
  SyncResult,
  RolesMapParams,
  RolesMapResult,
  SendParams,
  SendResult,
  
  // Support Tickets
  SupportTicket,
  TicketMessage,
} from "./types.js";

// ============================================================================
// Re-exports from types (for convenience)
// ============================================================================

export * from "./types.js";

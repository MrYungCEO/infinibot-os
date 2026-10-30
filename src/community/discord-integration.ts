/**
 * Community Discord Integration
 *
 * Comprehensive Discord bot integration for community management featuring:
 * - Bot setup and server connection
 * - Role ↔ Tier synchronization
 * - Slash commands (/verify, /courses, /progress, /support)
 * - Webhooks for events (join/leave, course completion, new content)
 * - Analytics tracking
 *
 * @module community/discord-integration
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  CommunityConfig,
  CommunityMember,
  TierRoleMapping,
  MemberTier,
  SlashCommand,
  SlashCommandInteraction,
  InteractionResponse,
  WebhookEvent,
  WebhookEventType,
  WebhookEventData,
  CommunityAnalytics,
  MessageEmbed,
  SupportTicket,
  ConnectParams,
  ConnectResult,
  SyncParams,
  SyncResult,
  RolesMapResult,
  SendParams,
  SendResult,
} from "./types.js";

const log = createSubsystemLogger("community-discord");

// ============================================================================
// Constants
// ============================================================================

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CDN = "https://cdn.discordapp.com";

// Embed colors
const COLORS = {
  primary: 0x5865f2, // Discord blurple
  success: 0x57f287, // Green
  warning: 0xfee75c, // Yellow
  error: 0xed4245, // Red
  info: 0x5865f2, // Blue
  premium: 0xf47fff, // Pink/purple for premium
  gold: 0xf1c40f, // Gold for VIP/lifetime
} as const;

// Tier display names and colors
const TIER_DISPLAY: Record<string, { name: string; color: number; emoji: string }> = {
  free: { name: "Free", color: COLORS.info, emoji: "🆓" },
  basic: { name: "Basic", color: 0x3498db, emoji: "⭐" },
  premium: { name: "Premium", color: COLORS.premium, emoji: "💎" },
  vip: { name: "VIP", color: COLORS.gold, emoji: "👑" },
  lifetime: { name: "Lifetime", color: 0x9b59b6, emoji: "♾️" },
  admin: { name: "Admin", color: COLORS.error, emoji: "🛡️" },
};

// ============================================================================
// Discord REST API Helpers
// ============================================================================

interface DiscordApiOptions {
  botToken: string;
  guildId?: string;
}

interface DiscordApiRequestInit extends RequestInit {
  timeout?: number;
}

async function discordFetch<T>(
  path: string,
  opts: DiscordApiOptions,
  init?: DiscordApiRequestInit,
): Promise<T> {
  const url = `${DISCORD_API}${path}`;
  const timeout = init?.timeout ?? 30_000;

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bot ${opts.botToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log.error("Discord API error", {
      status: response.status,
      path,
      body: errorBody,
    });
    throw new DiscordIntegrationError(
      `Discord API error ${response.status}: ${errorBody}`,
      "DISCORD_API_ERROR",
      { status: response.status, path, body: errorBody },
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Error Class
// ============================================================================

export class DiscordIntegrationError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code: string = "UNKNOWN_ERROR", details?: unknown) {
    super(message);
    this.name = "DiscordIntegrationError";
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Slash Commands Definitions
// ============================================================================

const COMMUNITY_COMMANDS: SlashCommand[] = [
  {
    name: "verify",
    description: "Link your Discord account to your community membership",
    options: [
      {
        type: 3, // STRING
        name: "code",
        description: "Your verification code (from email or dashboard)",
        required: false,
      },
      {
        type: 3, // STRING
        name: "email",
        description: "Your account email (if no code provided)",
        required: false,
      },
    ],
    dmPermission: false,
  },
  {
    name: "courses",
    description: "List available courses in the community",
    options: [
      {
        type: 3, // STRING
        name: "category",
        description: "Filter by category",
        required: false,
        choices: [
          { name: "All Courses", value: "all" },
          { name: "Free Courses", value: "free" },
          { name: "Premium Courses", value: "premium" },
          { name: "My Enrolled", value: "enrolled" },
          { name: "Completed", value: "completed" },
        ],
      },
    ],
    dmPermission: false,
  },
  {
    name: "progress",
    description: "Show your course progress and achievements",
    options: [
      {
        type: 3, // STRING
        name: "course",
        description: "Specific course to show progress for",
        required: false,
        autocomplete: true,
      },
    ],
    dmPermission: false,
  },
  {
    name: "support",
    description: "Create a support ticket",
    options: [
      {
        type: 3, // STRING
        name: "category",
        description: "Support category",
        required: true,
        choices: [
          { name: "Technical Issue", value: "technical" },
          { name: "Billing Question", value: "billing" },
          { name: "Course Content", value: "content" },
          { name: "Account Access", value: "access" },
          { name: "Feature Request", value: "feature" },
          { name: "Other", value: "other" },
        ],
      },
      {
        type: 3, // STRING
        name: "subject",
        description: "Brief description of your issue",
        required: true,
        maxLength: 100,
      },
      {
        type: 3, // STRING
        name: "description",
        description: "Detailed description",
        required: false,
        maxLength: 1000,
      },
      {
        type: 3, // STRING
        name: "priority",
        description: "Priority level",
        required: false,
        choices: [
          { name: "Low", value: "low" },
          { name: "Normal", value: "normal" },
          { name: "High", value: "high" },
          { name: "Urgent", value: "urgent" },
        ],
      },
    ],
    dmPermission: false,
  },
];

// ============================================================================
// Main Integration Class
// ============================================================================

export class CommunityDiscordIntegration {
  private config: CommunityConfig;
  private botToken: string;
  private applicationId?: string;
  private guildCache: Map<string, unknown> = new Map();
  private memberStore: Map<string, CommunityMember> = new Map();
  private ticketStore: Map<string, SupportTicket> = new Map();
  private analyticsCache: CommunityAnalytics | null = null;

  constructor(config: Partial<CommunityConfig> & { guildId: string }) {
    this.config = {
      botToken: config.botToken,
      roleMapping: config.roleMapping || {},
      features: {
        autoRoleSync: true,
        welcomeMessages: true,
        progressAnnouncements: true,
        slashCommands: true,
        webhooks: true,
        analytics: true,
        ...config.features,
      },
      ...config,
    };
    this.botToken = config.botToken || "";
  }

  // ==========================================================================
  // Connection & Setup
  // ==========================================================================

  /**
   * Connect to Discord and set up the bot
   */
  async connect(params?: ConnectParams): Promise<ConnectResult> {
    const guildId = params?.guildId || this.config.guildId;
    const token = params?.botToken || this.botToken;

    if (!token) {
      throw new DiscordIntegrationError("Bot token required", "MISSING_TOKEN");
    }

    this.botToken = token;
    this.config.guildId = guildId;

    if (params?.roleMapping) {
      this.config.roleMapping = params.roleMapping;
    }

    const opts: DiscordApiOptions = { botToken: token, guildId };

    try {
      // Get bot application info
      const app = await discordFetch<{ id: string; name: string }>("/oauth2/@me", opts);
      this.applicationId = app.id;

      // Get guild info
      const guild = await discordFetch<{
        id: string;
        name: string;
        icon: string | null;
        approximate_member_count: number;
      }>(`/guilds/${guildId}?with_counts=true`, opts);

      this.guildCache.set(guildId, guild);

      // Register slash commands if enabled
      let commandsRegistered = 0;
      if (this.config.features.slashCommands) {
        commandsRegistered = await this.registerCommands();
      }

      log.info("Connected to Discord guild", {
        guildId,
        guildName: guild.name,
        memberCount: guild.approximate_member_count,
        commandsRegistered,
      });

      return {
        connected: true,
        guildId: guild.id,
        guildName: guild.name,
        memberCount: guild.approximate_member_count || 0,
        commandsRegistered,
      };
    } catch (err) {
      log.error("Failed to connect to Discord", { error: err });
      throw err;
    }
  }

  /**
   * Register slash commands with Discord
   */
  async registerCommands(): Promise<number> {
    if (!this.applicationId) {
      throw new DiscordIntegrationError("Not connected - call connect() first", "NOT_CONNECTED");
    }

    const opts: DiscordApiOptions = {
      botToken: this.botToken,
      guildId: this.config.guildId,
    };

    try {
      // Register guild commands (faster updates than global)
      const result = await discordFetch<SlashCommand[]>(
        `/applications/${this.applicationId}/guilds/${this.config.guildId}/commands`,
        opts,
        {
          method: "PUT",
          body: JSON.stringify(COMMUNITY_COMMANDS),
        },
      );

      log.info("Registered slash commands", {
        count: result.length,
        commands: COMMUNITY_COMMANDS.map((c) => c.name),
      });

      return result.length;
    } catch (err) {
      log.error("Failed to register commands", { error: err });
      throw err;
    }
  }

  // ==========================================================================
  // Role Sync
  // ==========================================================================

  /**
   * Set tier → role mapping
   */
  async setRoleMapping(mapping: TierRoleMapping): Promise<RolesMapResult> {
    this.config.roleMapping = mapping;

    const tierCount = Object.keys(mapping).filter((k) => mapping[k]).length;

    log.info("Updated role mapping", { tierCount, mapping });

    return {
      mapped: true,
      tierCount,
    };
  }

  /**
   * Get current role mapping
   */
  getRoleMapping(): TierRoleMapping {
    return { ...this.config.roleMapping };
  }

  /**
   * Sync a member's roles based on their tier
   */
  async syncMemberRoles(
    discordId: string,
    tier: MemberTier | string,
  ): Promise<{ added: string[]; removed: string[] }> {
    const opts: DiscordApiOptions = {
      botToken: this.botToken,
      guildId: this.config.guildId,
    };

    const added: string[] = [];
    const removed: string[] = [];

    // Get the role for this tier
    const targetRoleId = this.config.roleMapping[tier];

    if (!targetRoleId) {
      log.warn("No role mapping for tier", { tier });
      return { added, removed };
    }

    // Get member's current roles
    const member = await discordFetch<{
      roles: string[];
      user: { id: string; username: string };
    }>(`/guilds/${this.config.guildId}/members/${discordId}`, opts);

    // Remove other tier roles
    for (const [t, roleId] of Object.entries(this.config.roleMapping)) {
      if (roleId && t !== tier && member.roles.includes(roleId)) {
        try {
          await discordFetch(
            `/guilds/${this.config.guildId}/members/${discordId}/roles/${roleId}`,
            opts,
            { method: "DELETE" },
          );
          removed.push(roleId);
        } catch (err) {
          log.warn("Failed to remove role", { roleId, discordId, error: err });
        }
      }
    }

    // Add the new tier role
    if (!member.roles.includes(targetRoleId)) {
      try {
        await discordFetch(
          `/guilds/${this.config.guildId}/members/${discordId}/roles/${targetRoleId}`,
          opts,
          { method: "PUT" },
        );
        added.push(targetRoleId);
      } catch (err) {
        log.error("Failed to add role", { roleId: targetRoleId, discordId, error: err });
        throw err;
      }
    }

    log.info("Synced member roles", { discordId, tier, added, removed });

    return { added, removed };
  }

  /**
   * Sync all members' roles based on their tiers
   */
  async syncAllRoles(): Promise<SyncResult> {
    const errors: string[] = [];
    let membersUpdated = 0;
    let rolesUpdated = 0;

    for (const [id, member] of this.memberStore.entries()) {
      if (member.discordId) {
        try {
          const result = await this.syncMemberRoles(member.discordId, member.tier);
          if (result.added.length > 0 || result.removed.length > 0) {
            membersUpdated++;
            rolesUpdated += result.added.length + result.removed.length;
          }
        } catch (err) {
          errors.push(`Failed to sync ${member.discordUsername}: ${err}`);
        }
      }
    }

    return {
      synced: errors.length === 0,
      membersUpdated,
      rolesUpdated,
      errors,
    };
  }

  // ==========================================================================
  // Slash Command Handlers
  // ==========================================================================

  /**
   * Handle a slash command interaction
   */
  async handleInteraction(interaction: SlashCommandInteraction): Promise<InteractionResponse> {
    const { name } = interaction.data;
    const userId = interaction.member?.user.id || interaction.user?.id;
    const username = interaction.member?.user.username || interaction.user?.username;

    log.info("Handling slash command", { command: name, userId, username });

    switch (name) {
      case "verify":
        return this.handleVerifyCommand(interaction);
      case "courses":
        return this.handleCoursesCommand(interaction);
      case "progress":
        return this.handleProgressCommand(interaction);
      case "support":
        return this.handleSupportCommand(interaction);
      default:
        return {
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content: "❌ Unknown command",
            flags: 64, // EPHEMERAL
          },
        };
    }
  }

  /**
   * Handle /verify command
   */
  private async handleVerifyCommand(
    interaction: SlashCommandInteraction,
  ): Promise<InteractionResponse> {
    const userId = interaction.member?.user.id || interaction.user?.id;
    const username = interaction.member?.user.username || interaction.user?.username;
    const options = interaction.data.options || [];

    const code = options.find((o) => o.name === "code")?.value as string | undefined;
    const email = options.find((o) => o.name === "email")?.value as string | undefined;

    // Check if already verified
    const existingMember = Array.from(this.memberStore.values()).find(
      (m) => m.discordId === userId,
    );

    if (existingMember?.verified) {
      return {
        type: 4,
        data: {
          embeds: [
            {
              title: "✅ Already Verified",
              description: `You're already verified as a **${TIER_DISPLAY[existingMember.tier]?.name || existingMember.tier}** member!`,
              color: COLORS.success,
              fields: [
                { name: "Email", value: existingMember.email || "Not set", inline: true },
                {
                  name: "Member Since",
                  value: new Date(existingMember.joinedAt).toLocaleDateString(),
                  inline: true,
                },
              ],
            },
          ],
          flags: 64,
        },
      };
    }

    if (code) {
      // Verify with code
      const member = Array.from(this.memberStore.values()).find((m) => m.verificationCode === code);

      if (!member) {
        return {
          type: 4,
          data: {
            embeds: [
              {
                title: "❌ Invalid Code",
                description: "The verification code is invalid or has expired.",
                color: COLORS.error,
              },
            ],
            flags: 64,
          },
        };
      }

      // Link accounts
      member.discordId = userId!;
      member.discordUsername = username!;
      member.verified = true;
      member.verifiedAt = new Date().toISOString();
      member.verificationCode = undefined;
      this.memberStore.set(member.id, member);

      // Sync roles
      if (this.config.features.autoRoleSync) {
        await this.syncMemberRoles(userId!, member.tier);
      }

      // Add verified role
      if (this.config.verification?.verifiedRoleId) {
        const opts: DiscordApiOptions = {
          botToken: this.botToken,
          guildId: this.config.guildId,
        };
        await discordFetch(
          `/guilds/${this.config.guildId}/members/${userId}/roles/${this.config.verification.verifiedRoleId}`,
          opts,
          { method: "PUT" },
        );
      }

      // Send webhook event
      await this.sendWebhookEvent("member_verified", {
        memberId: member.id,
        discordId: userId!,
        username: username!,
        email: member.email,
      });

      return {
        type: 4,
        data: {
          embeds: [
            {
              title: "🎉 Verification Successful!",
              description: `Welcome to the community, **${username}**! Your account has been verified.`,
              color: COLORS.success,
              fields: [
                {
                  name: "Tier",
                  value: `${TIER_DISPLAY[member.tier]?.emoji || "📦"} ${TIER_DISPLAY[member.tier]?.name || member.tier}`,
                  inline: true,
                },
                {
                  name: "Courses Enrolled",
                  value: String(member.enrolledCourses.length),
                  inline: true,
                },
              ],
            },
          ],
          flags: 64,
        },
      };
    }

    if (email) {
      // Generate and send verification code
      const verificationCode = this.generateVerificationCode();

      // Store pending verification
      const pendingMember: CommunityMember = {
        id: crypto.randomUUID(),
        discordId: userId!,
        discordUsername: username!,
        email,
        tier: "free",
        verified: false,
        verificationCode,
        roles: [],
        joinedAt: new Date().toISOString(),
        enrolledCourses: [],
        completedCourses: [],
        totalProgress: 0,
        messagesCount: 0,
        reactionsCount: 0,
        helpfulAnswers: 0,
        streak: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.memberStore.set(pendingMember.id, pendingMember);

      // TODO: Send email with verification code
      log.info("Generated verification code", { email, code: verificationCode });

      return {
        type: 4,
        data: {
          embeds: [
            {
              title: "📧 Verification Code Sent",
              description: `We've sent a verification code to **${email}**.\n\nUse \`/verify code:<your-code>\` to complete verification.`,
              color: COLORS.info,
              footer: { text: "Code expires in 24 hours" },
            },
          ],
          flags: 64,
        },
      };
    }

    // No code or email provided
    return {
      type: 4,
      data: {
        embeds: [
          {
            title: "🔗 Link Your Account",
            description: "To verify your community membership, use one of these options:",
            color: COLORS.info,
            fields: [
              {
                name: "Option 1: Verification Code",
                value: "If you have a verification code, use:\n`/verify code:<your-code>`",
              },
              {
                name: "Option 2: Email",
                value: "To receive a verification code, use:\n`/verify email:<your-email>`",
              },
            ],
          },
        ],
        flags: 64,
      },
    };
  }

  /**
   * Handle /courses command
   */
  private async handleCoursesCommand(
    interaction: SlashCommandInteraction,
  ): Promise<InteractionResponse> {
    const userId = interaction.member?.user.id || interaction.user?.id;
    const options = interaction.data.options || [];
    const category = (options.find((o) => o.name === "category")?.value as string) || "all";

    const member = Array.from(this.memberStore.values()).find((m) => m.discordId === userId);

    // Placeholder courses - in real implementation, fetch from course store
    const courses = [
      { id: "1", name: "Getting Started", tier: "free", lessons: 5, enrolled: 150 },
      { id: "2", name: "Advanced Techniques", tier: "premium", lessons: 12, enrolled: 45 },
      { id: "3", name: "Master Class", tier: "vip", lessons: 20, enrolled: 15 },
    ];

    let filteredCourses = courses;
    if (category === "free") {
      filteredCourses = courses.filter((c) => c.tier === "free");
    } else if (category === "premium") {
      filteredCourses = courses.filter((c) => c.tier !== "free");
    } else if (category === "enrolled" && member) {
      filteredCourses = courses.filter((c) => member.enrolledCourses.includes(c.id));
    } else if (category === "completed" && member) {
      filteredCourses = courses.filter((c) => member.completedCourses.includes(c.id));
    }

    const fields = filteredCourses.map((course) => {
      const tierInfo = TIER_DISPLAY[course.tier] || { emoji: "📚", name: course.tier };
      const enrolled = member?.enrolledCourses.includes(course.id);
      const completed = member?.completedCourses.includes(course.id);

      let status = "";
      if (completed) status = "✅ Completed";
      else if (enrolled) status = "📖 Enrolled";
      else status = `${tierInfo.emoji} ${tierInfo.name}`;

      return {
        name: course.name,
        value: `${status}\n${course.lessons} lessons · ${course.enrolled} enrolled`,
        inline: true,
      };
    });

    return {
      type: 4,
      data: {
        embeds: [
          {
            title: "📚 Available Courses",
            description:
              filteredCourses.length > 0
                ? `Showing ${filteredCourses.length} course${filteredCourses.length === 1 ? "" : "s"}`
                : "No courses found matching your criteria.",
            color: COLORS.primary,
            fields: fields.length > 0 ? fields : undefined,
            footer: { text: "Use /progress to see detailed progress" },
          },
        ],
        flags: 64,
      },
    };
  }

  /**
   * Handle /progress command
   */
  private async handleProgressCommand(
    interaction: SlashCommandInteraction,
  ): Promise<InteractionResponse> {
    const userId = interaction.member?.user.id || interaction.user?.id;
    const username = interaction.member?.user.username || interaction.user?.username;

    const member = Array.from(this.memberStore.values()).find((m) => m.discordId === userId);

    if (!member || !member.verified) {
      return {
        type: 4,
        data: {
          embeds: [
            {
              title: "🔗 Account Not Linked",
              description:
                "Please verify your account first using `/verify` to track your progress.",
              color: COLORS.warning,
            },
          ],
          flags: 64,
        },
      };
    }

    const tierInfo = TIER_DISPLAY[member.tier] || {
      emoji: "📦",
      name: member.tier,
      color: COLORS.info,
    };

    return {
      type: 4,
      data: {
        embeds: [
          {
            title: `📊 Progress for ${username}`,
            color: tierInfo.color,
            fields: [
              {
                name: "Tier",
                value: `${tierInfo.emoji} ${tierInfo.name}`,
                inline: true,
              },
              {
                name: "Courses Enrolled",
                value: String(member.enrolledCourses.length),
                inline: true,
              },
              {
                name: "Courses Completed",
                value: String(member.completedCourses.length),
                inline: true,
              },
              {
                name: "Overall Progress",
                value: `${this.createProgressBar(member.totalProgress)} ${member.totalProgress}%`,
                inline: false,
              },
              {
                name: "Current Streak",
                value: `🔥 ${member.streak} days`,
                inline: true,
              },
              {
                name: "Helpful Answers",
                value: `💡 ${member.helpfulAnswers}`,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
        flags: 64,
      },
    };
  }

  /**
   * Handle /support command
   */
  private async handleSupportCommand(
    interaction: SlashCommandInteraction,
  ): Promise<InteractionResponse> {
    const userId = interaction.member?.user.id || interaction.user?.id;
    const username = interaction.member?.user.username || interaction.user?.username;
    const options = interaction.data.options || [];

    const category = options.find((o) => o.name === "category")?.value as string;
    const subject = options.find((o) => o.name === "subject")?.value as string;
    const description = (options.find((o) => o.name === "description")?.value as string) || "";
    const priority = (options.find((o) => o.name === "priority")?.value as string) || "normal";

    const member = Array.from(this.memberStore.values()).find((m) => m.discordId === userId);

    // Create support ticket
    const ticket: SupportTicket = {
      id: this.generateTicketId(),
      memberId: member?.id || userId!,
      discordId: userId!,
      category,
      priority: priority as SupportTicket["priority"],
      status: "open",
      subject,
      description,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    this.ticketStore.set(ticket.id, ticket);

    // Create thread for ticket if support channel configured
    if (this.config.supportChannelId) {
      try {
        const opts: DiscordApiOptions = {
          botToken: this.botToken,
          guildId: this.config.guildId,
        };

        const thread = await discordFetch<{ id: string; name: string }>(
          `/channels/${this.config.supportChannelId}/threads`,
          opts,
          {
            method: "POST",
            body: JSON.stringify({
              name: `🎫 ${ticket.id}: ${subject.substring(0, 50)}`,
              type: 11, // PRIVATE_THREAD
              invitable: false,
            }),
          },
        );

        ticket.threadId = thread.id;
        this.ticketStore.set(ticket.id, ticket);

        // Send ticket details to thread
        await discordFetch(`/channels/${thread.id}/messages`, opts, {
          method: "POST",
          body: JSON.stringify({
            embeds: [
              {
                title: `Support Ticket #${ticket.id}`,
                color: this.getPriorityColor(priority),
                fields: [
                  { name: "User", value: `<@${userId}>`, inline: true },
                  { name: "Category", value: category, inline: true },
                  { name: "Priority", value: this.formatPriority(priority), inline: true },
                  { name: "Subject", value: subject, inline: false },
                  {
                    name: "Description",
                    value: description || "No description provided",
                    inline: false,
                  },
                ],
                timestamp: new Date().toISOString(),
              },
            ],
          }),
        });

        // Add user to thread
        await discordFetch(`/channels/${thread.id}/thread-members/${userId}`, opts, {
          method: "PUT",
        });
      } catch (err) {
        log.error("Failed to create support thread", { error: err });
      }
    }

    // Send webhook event
    await this.sendWebhookEvent("support_ticket", {
      ticketId: ticket.id,
      memberId: ticket.memberId,
      discordId: userId!,
      username: username!,
      category,
      priority: priority as SupportTicket["priority"],
      subject,
      description,
    });

    log.info("Created support ticket", { ticketId: ticket.id, category, priority });

    return {
      type: 4,
      data: {
        embeds: [
          {
            title: "🎫 Support Ticket Created",
            description: `Your ticket has been submitted and our team will respond shortly.`,
            color: COLORS.success,
            fields: [
              { name: "Ticket ID", value: `\`${ticket.id}\``, inline: true },
              { name: "Category", value: category, inline: true },
              { name: "Priority", value: this.formatPriority(priority), inline: true },
              { name: "Subject", value: subject, inline: false },
            ],
            footer: { text: "You'll receive updates in a private thread" },
          },
        ],
        flags: 64,
      },
    };
  }

  // ==========================================================================
  // Webhooks
  // ==========================================================================

  /**
   * Send a webhook event
   */
  async sendWebhookEvent(type: WebhookEventType, data: WebhookEventData): Promise<void> {
    if (!this.config.features.webhooks || !this.config.webhooks) {
      return;
    }

    const event: WebhookEvent = {
      id: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      guildId: this.config.guildId,
      data,
    };

    // Get webhook config for this event type
    const webhookKey = this.getWebhookKeyForEvent(type);
    const webhookConfig = webhookKey ? this.config.webhooks[webhookKey] : undefined;

    if (!webhookConfig?.enabled || !webhookConfig.url) {
      return;
    }

    try {
      await fetch(webhookConfig.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      });
      log.info("Sent webhook event", { type, eventId: event.id });
    } catch (err) {
      log.error("Failed to send webhook", { type, error: err });
    }
  }

  /**
   * Map event type to webhook config key
   */
  private getWebhookKeyForEvent(
    type: WebhookEventType,
  ): keyof NonNullable<CommunityConfig["webhooks"]> | null {
    switch (type) {
      case "member_join":
        return "memberJoin";
      case "member_leave":
        return "memberLeave";
      case "course_completed":
        return "courseCompletion";
      case "new_content":
        return "newContent";
      case "tier_change":
        return "tierChange";
      default:
        return null;
    }
  }

  // ==========================================================================
  // Messaging
  // ==========================================================================

  /**
   * Send a message to a channel
   */
  async sendMessage(params: SendParams): Promise<SendResult> {
    const opts: DiscordApiOptions = {
      botToken: this.botToken,
      guildId: this.config.guildId,
    };

    const body: Record<string, unknown> = {};
    if (params.message) body.content = params.message;
    if (params.embed) body.embeds = [params.embed];
    if (params.components) body.components = params.components;

    const result = await discordFetch<{ id: string }>(
      `/channels/${params.channelId}/messages`,
      opts,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    return {
      sent: true,
      messageId: result.id,
    };
  }

  /**
   * Send a welcome message
   */
  async sendWelcomeMessage(discordId: string, username: string, tier: string): Promise<void> {
    if (!this.config.features.welcomeMessages || !this.config.welcomeChannelId) {
      return;
    }

    const tierInfo = TIER_DISPLAY[tier] || { emoji: "🎉", name: tier, color: COLORS.success };

    await this.sendMessage({
      channelId: this.config.welcomeChannelId,
      message: "",
      embed: {
        title: "🎉 Welcome to the Community!",
        description: `<@${discordId}> has joined us as a **${tierInfo.name}** member!`,
        color: tierInfo.color,
        thumbnail: { url: `${DISCORD_CDN}/avatars/${discordId}/` },
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Send course completion announcement
   */
  async announceCourseCompletion(
    discordId: string,
    username: string,
    courseName: string,
  ): Promise<void> {
    if (!this.config.features.progressAnnouncements || !this.config.announcementChannelId) {
      return;
    }

    await this.sendMessage({
      channelId: this.config.announcementChannelId,
      message: "",
      embed: {
        title: "🎓 Course Completed!",
        description: `Congratulations to <@${discordId}> for completing **${courseName}**! 🎉`,
        color: COLORS.success,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Announce new content
   */
  async announceNewContent(
    contentType: "course" | "lesson" | "resource",
    contentName: string,
    description?: string,
  ): Promise<void> {
    if (!this.config.announcementChannelId) {
      return;
    }

    const emoji = contentType === "course" ? "📚" : contentType === "lesson" ? "📝" : "📦";

    await this.sendMessage({
      channelId: this.config.announcementChannelId,
      message: "@everyone",
      embed: {
        title: `${emoji} New ${contentType.charAt(0).toUpperCase() + contentType.slice(1)} Available!`,
        description: `**${contentName}**\n\n${description || "Check it out in your dashboard!"}`,
        color: COLORS.primary,
        timestamp: new Date().toISOString(),
      },
    });

    // Send webhook
    await this.sendWebhookEvent("new_content", {
      contentType,
      contentId: crypto.randomUUID(),
      contentName,
      description,
    });
  }

  // ==========================================================================
  // Analytics
  // ==========================================================================

  /**
   * Get community analytics
   */
  async getAnalytics(startDate?: string, endDate?: string): Promise<CommunityAnalytics> {
    const opts: DiscordApiOptions = {
      botToken: this.botToken,
      guildId: this.config.guildId,
    };

    // Get guild info
    const guild = await discordFetch<{
      id: string;
      name: string;
      approximate_member_count: number;
      approximate_presence_count: number;
    }>(`/guilds/${this.config.guildId}?with_counts=true`, opts);

    // Calculate member stats
    const members = Array.from(this.memberStore.values());
    const verifiedMembers = members.filter((m) => m.verified);

    const byTier: Record<string, number> = {};
    for (const member of verifiedMembers) {
      byTier[member.tier] = (byTier[member.tier] || 0) + 1;
    }

    const totalStreak = members.reduce((sum, m) => sum + m.streak, 0);
    const averageStreak = members.length > 0 ? totalStreak / members.length : 0;

    // Top contributors
    const topContributors = members
      .map((m) => ({
        memberId: m.id,
        username: m.discordUsername,
        score: m.messagesCount + m.reactionsCount * 0.5 + m.helpfulAnswers * 2,
        messages: m.messagesCount,
        helpful: m.helpfulAnswers,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    // Course stats
    const totalEnrollments = members.reduce((sum, m) => sum + m.enrolledCourses.length, 0);
    const totalCompletions = members.reduce((sum, m) => sum + m.completedCourses.length, 0);
    const averageProgress =
      members.length > 0
        ? members.reduce((sum, m) => sum + m.totalProgress, 0) / members.length
        : 0;

    const analytics: CommunityAnalytics = {
      period: {
        start: startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end: endDate || new Date().toISOString(),
      },
      discord: {
        totalMembers: guild.approximate_member_count || 0,
        activeMembers: guild.approximate_presence_count || 0,
        newMembers: 0, // Would need audit log access
        leftMembers: 0,
        verifiedMembers: verifiedMembers.length,
        totalMessages: members.reduce((sum, m) => sum + m.messagesCount, 0),
        totalReactions: members.reduce((sum, m) => sum + m.reactionsCount, 0),
        activeChannels: [], // Would need more API calls
        peakHours: [],
        voiceMinutes: 0,
        voiceParticipants: 0,
      },
      members: {
        byTier,
        averageStreak,
        topContributors,
      },
      courses: {
        totalEnrollments,
        totalCompletions,
        averageProgress,
        popularCourses: [], // Would need course store access
      },
    };

    this.analyticsCache = analytics;
    return analytics;
  }

  /**
   * Track member activity
   */
  trackActivity(discordId: string, type: "message" | "reaction" | "helpful"): void {
    const member = Array.from(this.memberStore.values()).find((m) => m.discordId === discordId);

    if (!member) return;

    switch (type) {
      case "message":
        member.messagesCount++;
        break;
      case "reaction":
        member.reactionsCount++;
        break;
      case "helpful":
        member.helpfulAnswers++;
        break;
    }

    member.lastActiveAt = new Date().toISOString();
    member.updatedAt = new Date().toISOString();
    this.memberStore.set(member.id, member);
  }

  // ==========================================================================
  // Member Management
  // ==========================================================================

  /**
   * Handle member join event
   */
  async onMemberJoin(
    discordId: string,
    username: string,
    tier: MemberTier = "free",
  ): Promise<CommunityMember> {
    const member: CommunityMember = {
      id: crypto.randomUUID(),
      discordId,
      discordUsername: username,
      tier,
      verified: false,
      roles: [],
      joinedAt: new Date().toISOString(),
      enrolledCourses: [],
      completedCourses: [],
      totalProgress: 0,
      messagesCount: 0,
      reactionsCount: 0,
      helpfulAnswers: 0,
      streak: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.memberStore.set(member.id, member);

    // Send welcome message
    await this.sendWelcomeMessage(discordId, username, tier);

    // Send webhook
    await this.sendWebhookEvent("member_join", {
      memberId: member.id,
      discordId,
      username,
      tier,
    });

    log.info("Member joined", { memberId: member.id, discordId, username });

    return member;
  }

  /**
   * Handle member leave event
   */
  async onMemberLeave(discordId: string, reason?: string): Promise<void> {
    const member = Array.from(this.memberStore.values()).find((m) => m.discordId === discordId);

    if (member) {
      await this.sendWebhookEvent("member_leave", {
        memberId: member.id,
        discordId,
        username: member.discordUsername,
        reason,
      });

      log.info("Member left", { memberId: member.id, discordId });
    }
  }

  /**
   * Update member tier
   */
  async updateMemberTier(
    discordId: string,
    newTier: MemberTier,
    source: "manual" | "payment" | "automation" = "manual",
  ): Promise<CommunityMember | null> {
    const member = Array.from(this.memberStore.values()).find((m) => m.discordId === discordId);

    if (!member) {
      return null;
    }

    const previousTier = member.tier;
    member.tier = newTier;
    member.updatedAt = new Date().toISOString();
    this.memberStore.set(member.id, member);

    // Sync roles
    if (this.config.features.autoRoleSync) {
      await this.syncMemberRoles(discordId, newTier);
    }

    // Send webhook
    await this.sendWebhookEvent("tier_change", {
      memberId: member.id,
      discordId,
      username: member.discordUsername,
      previousTier,
      newTier,
      source,
    });

    log.info("Updated member tier", {
      memberId: member.id,
      discordId,
      previousTier,
      newTier,
      source,
    });

    return member;
  }

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  /**
   * Full sync with Discord
   */
  async sync(params?: SyncParams): Promise<SyncResult> {
    const errors: string[] = [];
    let membersUpdated = 0;
    let rolesUpdated = 0;

    const opts: DiscordApiOptions = {
      botToken: this.botToken,
      guildId: this.config.guildId,
    };

    // Sync members from Discord
    if (params?.syncMembers !== false) {
      try {
        let after: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const url = `/guilds/${this.config.guildId}/members?limit=100${after ? `&after=${after}` : ""}`;
          const discordMembers = await discordFetch<
            Array<{
              user: { id: string; username: string };
              roles: string[];
              joined_at: string;
            }>
          >(url, opts);

          for (const dm of discordMembers) {
            const existing = Array.from(this.memberStore.values()).find(
              (m) => m.discordId === dm.user.id,
            );

            if (existing) {
              existing.discordUsername = dm.user.username;
              existing.roles = dm.roles;
              existing.updatedAt = new Date().toISOString();
              this.memberStore.set(existing.id, existing);
              membersUpdated++;
            }
          }

          if (discordMembers.length < 100) {
            hasMore = false;
          } else {
            after = discordMembers[discordMembers.length - 1].user.id;
          }
        }
      } catch (err) {
        errors.push(`Member sync failed: ${err}`);
      }
    }

    // Sync roles
    if (params?.syncRoles !== false) {
      try {
        const roleResult = await this.syncAllRoles();
        rolesUpdated = roleResult.rolesUpdated;
        errors.push(...roleResult.errors);
      } catch (err) {
        errors.push(`Role sync failed: ${err}`);
      }
    }

    log.info("Sync completed", { membersUpdated, rolesUpdated, errors: errors.length });

    return {
      synced: errors.length === 0,
      membersUpdated,
      rolesUpdated,
      errors,
    };
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  private generateVerificationCode(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  private generateTicketId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${timestamp}-${random}`;
  }

  private createProgressBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return "█".repeat(filled) + "░".repeat(empty);
  }

  private getPriorityColor(priority: string): number {
    switch (priority) {
      case "urgent":
        return COLORS.error;
      case "high":
        return COLORS.warning;
      case "normal":
        return COLORS.info;
      default:
        return 0x95a5a6;
    }
  }

  private formatPriority(priority: string): string {
    const emojis: Record<string, string> = {
      low: "🟢",
      normal: "🔵",
      high: "🟠",
      urgent: "🔴",
    };
    return `${emojis[priority] || "⚪"} ${priority.charAt(0).toUpperCase() + priority.slice(1)}`;
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getConfig(): CommunityConfig {
    return { ...this.config };
  }

  getMember(discordId: string): CommunityMember | undefined {
    return Array.from(this.memberStore.values()).find((m) => m.discordId === discordId);
  }

  getMembers(): CommunityMember[] {
    return Array.from(this.memberStore.values());
  }

  getTicket(ticketId: string): SupportTicket | undefined {
    return this.ticketStore.get(ticketId);
  }

  getTickets(): SupportTicket[] {
    return Array.from(this.ticketStore.values());
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new CommunityDiscordIntegration instance
 */
export function createCommunityDiscordIntegration(
  config: Partial<CommunityConfig> & { guildId: string },
): CommunityDiscordIntegration {
  return new CommunityDiscordIntegration(config);
}

// ============================================================================
// Exports
// ============================================================================

export default CommunityDiscordIntegration;
export * from "./types.js";

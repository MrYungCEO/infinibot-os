/**
 * Kingly Vault - Discord Moderation
 *
 * Moderation actions: warn, timeout, kick, ban, unban.
 * Warnings are stored client-side (caller persists to store).
 * Timeout/kick/ban/unban call Discord API directly.
 */

import type { APIGuildMember } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import {
  createVaultDiscordClient,
  wrapDiscordError,
  type VaultDiscordClientOpts,
} from "./client.js";
import type {
  Warning,
  WarningSeverity,
  TimeoutTarget,
  BanTarget,
  LoggableModerationAction,
  DiscordMember,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type WarnOptions = VaultDiscordClientOpts & {
  /** Moderator who issued the warning */
  moderatorId?: string;
  /** Optional expiration for the warning */
  expiresAt?: Date;
};

export type TimeoutOptions = VaultDiscordClientOpts & {
  /** Moderator who issued the timeout */
  moderatorId?: string;
};

export type KickOptions = VaultDiscordClientOpts & {
  /** Moderator who issued the kick */
  moderatorId?: string;
};

export type BanOptions = VaultDiscordClientOpts & {
  /** Moderator who issued the ban */
  moderatorId?: string;
  /** Number of days of messages to delete (0-7) */
  deleteMessageDays?: number;
};

export type UnbanOptions = VaultDiscordClientOpts & {
  /** Moderator who issued the unban */
  moderatorId?: string;
};

export type ModerationResult<T = void> = {
  success: boolean;
  data?: T;
  error?: string;
  action: LoggableModerationAction;
};

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function buildAuditLogHeaders(reason?: string): Record<string, string> | undefined {
  if (!reason) return undefined;
  return { "X-Audit-Log-Reason": encodeURIComponent(reason) };
}

function normalizeMember(raw: APIGuildMember, guildId: string): DiscordMember {
  // user may be partial or undefined in some contexts
  const user = raw.user ?? { id: "unknown", username: "unknown" };
  const globalName = (user as { global_name?: string }).global_name;
  const joinedAt = raw.joined_at ? new Date(raw.joined_at) : new Date();
  const premiumSince = raw.premium_since ? new Date(raw.premium_since) : null;
  const disabledUntil = raw.communication_disabled_until
    ? new Date(raw.communication_disabled_until)
    : null;

  return {
    id: `${guildId}:${user.id}`,
    guildId,
    userId: user.id,
    nickname: raw.nick ?? null,
    displayName: raw.nick ?? globalName ?? user.username,
    username: user.username,
    discriminator: (user as { discriminator?: string }).discriminator,
    avatar: raw.avatar ?? (user as { avatar?: string | null }).avatar ?? null,
    roles: raw.roles,
    joinedAt,
    premiumSince,
    deaf: raw.deaf,
    mute: raw.mute,
    pending: raw.pending,
    communicationDisabledUntil: disabledUntil,
  };
}

// ============================================================================
// Warning (Client-Side)
// ============================================================================

/**
 * Creates a warning for a member.
 *
 * Warnings are NOT stored in Discord - they're returned for the caller to persist.
 * The warning includes all data needed for logging to the Vault store.
 *
 * @returns Warning object with ID and timestamp for persistence
 */
export async function warnMember(
  guildId: string,
  userId: string,
  reason: string,
  severity: WarningSeverity,
  opts: WarnOptions = {},
): Promise<Warning> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new Error("Warning reason is required");
  }

  const warning = {
    id: generateId(),
    guildId,
    moderatorId: opts.moderatorId ?? "system",
    userId,
    reason: trimmedReason,
    severity,
    createdAt: new Date(),
    expiresAt: opts.expiresAt,
  } as any as Warning;

  // Note: We could optionally DM the user about the warning here.
  // For now, the warning is just created for logging - caller decides
  // whether to notify the user.

  return warning;
}

// ============================================================================
// Timeout
// ============================================================================

/**
 * Times out (mutes) a member for a specified duration.
 *
 * Discord timeout uses the communication_disabled_until field.
 * Maximum timeout is 28 days.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID to timeout
 * @param durationMs - Duration in milliseconds
 * @param reason - Optional reason (shown in audit log)
 * @returns The updated member data
 */
export async function timeoutMember(
  guildId: string,
  userId: string,
  durationMs: number,
  reason?: string,
  opts: TimeoutOptions = {},
): Promise<ModerationResult<DiscordMember>> {
  const action: LoggableModerationAction = {
    type: "timeout",
    guildId,
    targetUserId: userId,
    moderatorId: opts.moderatorId,
    reason,
    duration: durationMs,
  };

  try {
    const { rest } = createVaultDiscordClient(opts);

    // Calculate timeout end time
    const maxDurationMs = 28 * 24 * 60 * 60 * 1000; // 28 days max
    const clampedDuration = Math.min(durationMs, maxDurationMs);
    const until = new Date(Date.now() + clampedDuration).toISOString();

    const member = (await rest.patch(Routes.guildMember(guildId, userId), {
      body: { communication_disabled_until: until },
      headers: buildAuditLogHeaders(reason),
    })) as APIGuildMember;

    return {
      success: true,
      data: normalizeMember(member, guildId),
      action,
    };
  } catch (err) {
    const wrapped = wrapDiscordError(err, "Failed to timeout member");
    return {
      success: false,
      error: wrapped.message,
      action,
    };
  }
}

/**
 * Removes timeout from a member.
 */
export async function removeTimeout(
  guildId: string,
  userId: string,
  reason?: string,
  opts: TimeoutOptions = {},
): Promise<ModerationResult<DiscordMember>> {
  const action: LoggableModerationAction = {
    type: "timeout",
    guildId,
    targetUserId: userId,
    moderatorId: opts.moderatorId,
    reason: reason ?? "Timeout removed",
    duration: 0,
    metadata: { removed: true },
  };

  try {
    const { rest } = createVaultDiscordClient(opts);

    const member = (await rest.patch(Routes.guildMember(guildId, userId), {
      body: { communication_disabled_until: null },
      headers: buildAuditLogHeaders(reason),
    })) as APIGuildMember;

    return {
      success: true,
      data: normalizeMember(member, guildId),
      action,
    };
  } catch (err) {
    const wrapped = wrapDiscordError(err, "Failed to remove timeout");
    return {
      success: false,
      error: wrapped.message,
      action,
    };
  }
}

// ============================================================================
// Kick
// ============================================================================

/**
 * Kicks a member from the guild.
 *
 * The member can rejoin with a new invite.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID to kick
 * @param reason - Optional reason (shown in audit log)
 */
export async function kickMember(
  guildId: string,
  userId: string,
  reason?: string,
  opts: KickOptions = {},
): Promise<ModerationResult> {
  const action: LoggableModerationAction = {
    type: "kick",
    guildId,
    targetUserId: userId,
    moderatorId: opts.moderatorId,
    reason,
  };

  try {
    const { rest } = createVaultDiscordClient(opts);

    await rest.delete(Routes.guildMember(guildId, userId), {
      headers: buildAuditLogHeaders(reason),
    });

    return {
      success: true,
      action,
    };
  } catch (err) {
    const wrapped = wrapDiscordError(err, "Failed to kick member");
    return {
      success: false,
      error: wrapped.message,
      action,
    };
  }
}

// ============================================================================
// Ban
// ============================================================================

/**
 * Bans a user from the guild.
 *
 * Banned users cannot rejoin until unbanned.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID to ban
 * @param reason - Optional reason (shown in audit log)
 * @param deleteMessageDays - Days of messages to delete (0-7)
 */
export async function banMember(
  guildId: string,
  userId: string,
  reason?: string,
  deleteMessageDays?: number,
  opts: BanOptions = {},
): Promise<ModerationResult> {
  const action: LoggableModerationAction = {
    type: "ban",
    guildId,
    targetUserId: userId,
    moderatorId: opts.moderatorId,
    reason,
    metadata: deleteMessageDays !== undefined ? { deleteMessageDays } : undefined,
  };

  try {
    const { rest } = createVaultDiscordClient(opts);

    // Clamp delete_message_days to valid range
    const days =
      deleteMessageDays !== undefined
        ? Math.min(Math.max(Math.floor(deleteMessageDays), 0), 7)
        : undefined;

    await rest.put(Routes.guildBan(guildId, userId), {
      body: days !== undefined ? { delete_message_days: days } : undefined,
      headers: buildAuditLogHeaders(reason),
    });

    return {
      success: true,
      action,
    };
  } catch (err) {
    const wrapped = wrapDiscordError(err, "Failed to ban member");
    return {
      success: false,
      error: wrapped.message,
      action,
    };
  }
}

// ============================================================================
// Unban
// ============================================================================

/**
 * Unbans a user from the guild.
 *
 * The user can now rejoin with an invite.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID to unban
 */
export async function unbanMember(
  guildId: string,
  userId: string,
  opts: UnbanOptions = {},
): Promise<ModerationResult> {
  const action: LoggableModerationAction = {
    type: "unban",
    guildId,
    targetUserId: userId,
    moderatorId: opts.moderatorId,
  };

  try {
    const { rest } = createVaultDiscordClient(opts);

    await rest.delete(Routes.guildBan(guildId, userId));

    return {
      success: true,
      action,
    };
  } catch (err) {
    const wrapped = wrapDiscordError(err, "Failed to unban member");
    return {
      success: false,
      error: wrapped.message,
      action,
    };
  }
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Gets a member's current timeout status.
 */
export async function getTimeoutStatus(
  guildId: string,
  userId: string,
  opts: VaultDiscordClientOpts = {},
): Promise<{ timedOut: boolean; until?: Date }> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const member = (await rest.get(Routes.guildMember(guildId, userId))) as APIGuildMember;

    if (member.communication_disabled_until) {
      const until = new Date(member.communication_disabled_until);
      return {
        timedOut: until > new Date(),
        until,
      };
    }

    return { timedOut: false };
  } catch {
    return { timedOut: false };
  }
}

/**
 * Checks if a user is banned from a guild.
 */
export async function isBanned(
  guildId: string,
  userId: string,
  opts: VaultDiscordClientOpts = {},
): Promise<boolean> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.get(Routes.guildBan(guildId, userId));
    return true;
  } catch {
    return false;
  }
}

// Types are exported inline above

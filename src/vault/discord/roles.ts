/**
 * Kingly Vault - Discord Role Management
 *
 * Role operations: list, create, assign, remove, edit, delete.
 */

import type { APIRole } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import { createVaultDiscordClient, wrapDiscordError, type VaultDiscordClientOpts } from "./client.js";
import type { DiscordRole, RoleConfig } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type RoleOptions = VaultDiscordClientOpts;

export type RoleEditConfig = Partial<RoleConfig> & {
  /** Role ID to edit */
  roleId: string;
};

// ============================================================================
// Helper Functions
// ============================================================================

function normalizeRole(raw: APIRole, guildId: string): DiscordRole {
  return {
    id: raw.id,
    guildId,
    name: raw.name,
    color: raw.color,
    hoist: raw.hoist,
    icon: raw.icon,
    position: raw.position,
    permissions: raw.permissions,
    managed: raw.managed,
    mentionable: raw.mentionable,
  };
}

function buildRolePayload(config: RoleConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: config.name,
  };

  if (config.color !== undefined) body.color = config.color;
  if (config.hoist !== undefined) body.hoist = config.hoist;
  if (config.mentionable !== undefined) body.mentionable = config.mentionable;
  if (config.permissions !== undefined) body.permissions = config.permissions;
  if (config.icon !== undefined) body.icon = config.icon;
  if (config.unicodeEmoji !== undefined) body.unicode_emoji = config.unicodeEmoji;

  return body;
}

// ============================================================================
// List Roles
// ============================================================================

/**
 * Gets all roles in a guild.
 *
 * Roles are returned sorted by position (highest first).
 *
 * @param guildId - The guild ID
 * @returns Array of roles
 */
export async function getRoles(
  guildId: string,
  opts: RoleOptions = {},
): Promise<DiscordRole[]> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const roles = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];

    return roles
      .map((r) => normalizeRole(r, guildId))
      .sort((a, b) => b.position - a.position);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to get roles");
  }
}

/**
 * Gets a specific role by ID.
 *
 * @param guildId - The guild ID
 * @param roleId - The role ID
 * @returns The role or null if not found
 */
export async function getRole(
  guildId: string,
  roleId: string,
  opts: RoleOptions = {},
): Promise<DiscordRole | null> {
  try {
    const roles = await getRoles(guildId, opts);
    return roles.find((r) => r.id === roleId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Finds a role by name (case-insensitive).
 *
 * @param guildId - The guild ID
 * @param name - The role name to search for
 * @returns The first matching role or null
 */
export async function findRoleByName(
  guildId: string,
  name: string,
  opts: RoleOptions = {},
): Promise<DiscordRole | null> {
  try {
    const roles = await getRoles(guildId, opts);
    const lowerName = name.toLowerCase();
    return roles.find((r) => r.name.toLowerCase() === lowerName) ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Create Role
// ============================================================================

/**
 * Creates a new role in a guild.
 *
 * @param guildId - The guild ID
 * @param config - Role configuration
 * @returns The created role
 */
export async function createRole(
  guildId: string,
  config: RoleConfig,
  opts: RoleOptions = {},
): Promise<DiscordRole> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body = buildRolePayload(config);

    const role = (await rest.post(Routes.guildRoles(guildId), {
      body,
    })) as APIRole;

    // If position was specified, move the role
    if (config.position !== undefined) {
      try {
        await rest.patch(Routes.guildRoles(guildId), {
          body: [{ id: role.id, position: config.position }],
        });
      } catch {
        // Position change failed, but role was created
      }
    }

    return normalizeRole(role, guildId);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to create role");
  }
}

// ============================================================================
// Edit Role
// ============================================================================

/**
 * Edits an existing role.
 *
 * @param guildId - The guild ID
 * @param roleId - The role ID to edit
 * @param config - Partial role configuration
 * @returns The updated role
 */
export async function editRole(
  guildId: string,
  roleId: string,
  config: Partial<RoleConfig>,
  opts: RoleOptions = {},
): Promise<DiscordRole> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body: Record<string, unknown> = {};
    if (config.name !== undefined) body.name = config.name;
    if (config.color !== undefined) body.color = config.color;
    if (config.hoist !== undefined) body.hoist = config.hoist;
    if (config.mentionable !== undefined) body.mentionable = config.mentionable;
    if (config.permissions !== undefined) body.permissions = config.permissions;
    if (config.icon !== undefined) body.icon = config.icon;
    if (config.unicodeEmoji !== undefined) body.unicode_emoji = config.unicodeEmoji;

    const role = (await rest.patch(Routes.guildRole(guildId, roleId), {
      body,
    })) as APIRole;

    // If position was specified, move the role
    if (config.position !== undefined) {
      try {
        await rest.patch(Routes.guildRoles(guildId), {
          body: [{ id: role.id, position: config.position }],
        });
      } catch {
        // Position change failed, but role was updated
      }
    }

    return normalizeRole(role, guildId);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to edit role");
  }
}

// ============================================================================
// Delete Role
// ============================================================================

/**
 * Deletes a role from a guild.
 *
 * @param guildId - The guild ID
 * @param roleId - The role ID to delete
 */
export async function deleteRole(
  guildId: string,
  roleId: string,
  opts: RoleOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.delete(Routes.guildRole(guildId, roleId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to delete role");
  }
}

// ============================================================================
// Assign/Remove Role
// ============================================================================

/**
 * Assigns a role to a guild member.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID
 * @param roleId - The role ID to assign
 */
export async function assignRole(
  guildId: string,
  userId: string,
  roleId: string,
  opts: RoleOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.put(Routes.guildMemberRole(guildId, userId, roleId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to assign role");
  }
}

/**
 * Removes a role from a guild member.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID
 * @param roleId - The role ID to remove
 */
export async function removeRole(
  guildId: string,
  userId: string,
  roleId: string,
  opts: RoleOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.delete(Routes.guildMemberRole(guildId, userId, roleId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to remove role");
  }
}

// ============================================================================
// Bulk Role Operations
// ============================================================================

/**
 * Assigns multiple roles to a member at once.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID
 * @param roleIds - Array of role IDs to assign
 */
export async function assignRoles(
  guildId: string,
  userId: string,
  roleIds: string[],
  opts: RoleOptions = {},
): Promise<void> {
  for (const roleId of roleIds) {
    await assignRole(guildId, userId, roleId, opts);
  }
}

/**
 * Removes multiple roles from a member at once.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID
 * @param roleIds - Array of role IDs to remove
 */
export async function removeRoles(
  guildId: string,
  userId: string,
  roleIds: string[],
  opts: RoleOptions = {},
): Promise<void> {
  for (const roleId of roleIds) {
    await removeRole(guildId, userId, roleId, opts);
  }
}

/**
 * Gets a member's current roles.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID
 * @returns Array of role IDs the member has
 */
export async function getMemberRoles(
  guildId: string,
  userId: string,
  opts: RoleOptions = {},
): Promise<string[]> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const member = (await rest.get(Routes.guildMember(guildId, userId))) as { roles: string[] };
    return member.roles;
  } catch {
    return [];
  }
}

/**
 * Checks if a member has a specific role.
 *
 * @param guildId - The guild ID
 * @param userId - The user ID
 * @param roleId - The role ID to check
 * @returns Whether the member has the role
 */
export async function hasRole(
  guildId: string,
  userId: string,
  roleId: string,
  opts: RoleOptions = {},
): Promise<boolean> {
  const roles = await getMemberRoles(guildId, userId, opts);
  return roles.includes(roleId);
}

// Types are exported inline above

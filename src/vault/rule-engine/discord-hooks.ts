/**
 * Vault Rule Engine — Discord Hooks
 * Connects the rule engine to InfiniBot's Discord event system
 */

import {
  initRuleEngine,
  processMessage,
  processMemberJoin,
  processMemberLeave,
  processRoleChange,
  isEngineRunning,
  getEngineStats,
} from './engine.js';
import type { RuleEngineConfig } from './types.js';
import { createSubsystemLogger } from '../../logging/subsystem.js';

const log = createSubsystemLogger('vault-rule-hooks');

let hookEnabled = false;
let configuredGuildId: string | null = null;

// ═══════════════════════════════════════════════════════════════
// HOOK SETUP
// ═══════════════════════════════════════════════════════════════

/**
 * Initialize the Discord hooks for the rule engine
 */
export async function initDiscordHooks(config: RuleEngineConfig): Promise<void> {
  log.info('Initializing Discord hooks for rule engine', { guildId: config.guildId });
  
  await initRuleEngine(config);
  configuredGuildId = config.guildId;
  hookEnabled = true;
  
  log.info('Discord hooks initialized');
}

/**
 * Check if hooks are active
 */
export function isHookEnabled(): boolean {
  return hookEnabled && isEngineRunning();
}

/**
 * Get hook status
 */
export function getHookStatus(): {
  enabled: boolean;
  guildId: string | null;
  stats: ReturnType<typeof getEngineStats>;
} {
  return {
    enabled: isHookEnabled(),
    guildId: configuredGuildId,
    stats: getEngineStats(),
  };
}

// Re-export for gateway
export { isEngineRunning };

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLERS (simplified for any message/member shape)
// ═══════════════════════════════════════════════════════════════

/**
 * Handle incoming Discord message
 * Call this from the Discord message listener
 */
export async function handleDiscordMessage(
  message: {
    id: string;
    content?: string;
    channelId: string;
    guildId?: string;
    author?: { id: string; username: string; bot?: boolean };
    attachments?: unknown[];
    mentions?: { users?: { id: string }[] };
  }
): Promise<void> {
  if (!isHookEnabled() || !configuredGuildId) return;
  
  // Skip bot messages
  if (message.author?.bot) return;
  
  // Skip DMs
  if (!message.guildId) return;
  
  // Only process messages from our guild
  if (message.guildId !== configuredGuildId) return;
  
  try {
    const results = await processMessage(
      {
        id: message.id,
        content: message.content || '',
        channelId: message.channelId,
        author: {
          id: message.author?.id || 'unknown',
          username: message.author?.username || 'Unknown',
        },
        attachments: message.attachments,
        mentions: message.mentions?.users?.map(u => ({ id: u.id })),
      },
      configuredGuildId
    );
    
    if (results.length > 0) {
      log.info('Message triggered rules', {
        messageId: message.id,
        rulesTriggered: results.length,
        results: results.map(r => ({
          rule: r.ruleName,
          success: r.success,
          actions: r.actionsExecuted.length,
        })),
      });
    }
  } catch (err) {
    log.error('Error processing message through rule engine', { error: err });
  }
}

/**
 * Handle member join
 */
export async function handleMemberJoin(
  member: {
    id: string;
    guildId?: string;
    username?: string;
    joinedAt?: string | Date;
    roles?: string[];
  }
): Promise<void> {
  if (!isHookEnabled() || !configuredGuildId) return;
  
  const memberGuildId = member.guildId;
  if (memberGuildId && memberGuildId !== configuredGuildId) return;
  
  try {
    const results = await processMemberJoin(
      {
        id: member.id,
        username: member.username || 'Unknown',
        joinedAt: member.joinedAt ? new Date(member.joinedAt) : undefined,
        roles: member.roles || [],
      },
      configuredGuildId
    );
    
    if (results.length > 0) {
      log.info('Member join triggered rules', {
        memberId: member.id,
        rulesTriggered: results.length,
      });
    }
  } catch (err) {
    log.error('Error processing member join through rule engine', { error: err });
  }
}

/**
 * Handle member leave
 */
export async function handleMemberLeave(
  member: {
    id: string;
    guildId?: string;
    username?: string;
    roles?: string[];
  }
): Promise<void> {
  if (!isHookEnabled() || !configuredGuildId) return;
  
  const memberGuildId = member.guildId;
  if (memberGuildId && memberGuildId !== configuredGuildId) return;
  
  try {
    const results = await processMemberLeave(
      {
        id: member.id,
        username: member.username || 'Unknown',
        roles: member.roles || [],
      },
      configuredGuildId
    );
    
    if (results.length > 0) {
      log.info('Member leave triggered rules', {
        memberId: member.id,
        rulesTriggered: results.length,
      });
    }
  } catch (err) {
    log.error('Error processing member leave through rule engine', { error: err });
  }
}

/**
 * Handle role change
 */
export async function handleRoleChange(
  memberId: string,
  username: string,
  roleId: string,
  roleName: string,
  action: 'add' | 'remove'
): Promise<void> {
  if (!isHookEnabled() || !configuredGuildId) return;
  
  try {
    const results = await processRoleChange(
      {
        userId: memberId,
        username,
        roleId,
        roleName,
        action,
      },
      configuredGuildId
    );
    
    if (results.length > 0) {
      log.info('Role change triggered rules', {
        memberId,
        roleId,
        action,
        rulesTriggered: results.length,
      });
    }
  } catch (err) {
    log.error('Error processing role change through rule engine', { error: err });
  }
}

// ═══════════════════════════════════════════════════════════════
// STARTUP HELPER
// ═══════════════════════════════════════════════════════════════

/**
 * Start the rule engine with environment config
 */
export async function startRuleEngineFromEnv(opts?: Partial<RuleEngineConfig>): Promise<boolean> {
  const envGuildId = process.env.DISCORD_GUILD_ID || process.env.VAULT_DISCORD_GUILD_ID;
  const envBotToken = process.env.DISCORD_BOT_TOKEN || process.env.VAULT_DISCORD_TOKEN;
  
  if (!envGuildId || !envBotToken) {
    log.warn('Cannot start rule engine: missing DISCORD_GUILD_ID or DISCORD_BOT_TOKEN');
    return false;
  }
  
  await initDiscordHooks({
    guildId: envGuildId,
    botToken: envBotToken,
    autonomyLevel: 3,
    dryRun: false,
    verbose: true,
    ...opts,
  });
  
  return true;
}

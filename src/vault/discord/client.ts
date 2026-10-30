/**
 * Kingly Vault - Discord Client
 *
 * Wraps the existing InfiniBot Discord REST client pattern.
 * Reuses account resolution and token management from the core discord module.
 */

import { RequestClient } from "@buape/carbon";
import type { InfinibotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { resolveDiscordAccount, type ResolvedDiscordAccount } from "../../discord/accounts.js";
import { normalizeDiscordToken } from "../../discord/token.js";
import { createDiscordRetryRunner, type RetryRunner } from "../../infra/retry-policy.js";
import type { RetryConfig } from "../../infra/retry.js";
import type { DiscordApiOpts, VaultDiscordError } from "./types.js";

// ============================================================================
// Client Types
// ============================================================================

export type VaultDiscordClientOpts = {
  /** Explicit token (overrides account lookup) */
  token?: string;
  /** Account ID to use for token lookup */
  accountId?: string;
  /** Existing REST client to reuse */
  rest?: RequestClient;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Enable verbose logging */
  verbose?: boolean;
};

export type VaultDiscordClient = {
  /** The REST client for making Discord API requests */
  rest: RequestClient;
  /** Retry-wrapped request executor */
  request: RetryRunner;
  /** The bot token being used */
  token: string;
  /** The resolved account information */
  account: ResolvedDiscordAccount;
};

// ============================================================================
// Error Handling
// ============================================================================

export class VaultDiscordClientError extends Error {
  code: string;
  discordCode?: number;
  details?: unknown;

  constructor(message: string, opts: Partial<VaultDiscordError> = {}) {
    super(message);
    this.name = "VaultDiscordClientError";
    this.code = opts.code ?? "UNKNOWN_ERROR";
    this.discordCode = opts.discordCode;
    this.details = opts.details;
  }
}

// Common Discord error codes
export const DISCORD_ERROR_CODES = {
  UNKNOWN_MESSAGE: 10008,
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_GUILD: 10004,
  UNKNOWN_MEMBER: 10007,
  UNKNOWN_ROLE: 10011,
  UNKNOWN_USER: 10013,
  UNKNOWN_BAN: 10026,
  MISSING_ACCESS: 50001,
  MISSING_PERMISSIONS: 50013,
  CANNOT_DM_USER: 50007,
  RATE_LIMITED: 429,
} as const;

// ============================================================================
// Client Creation
// ============================================================================

function resolveToken(params: {
  explicit?: string;
  accountId: string;
  fallbackToken?: string;
}): string {
  const explicit = normalizeDiscordToken(params.explicit);
  if (explicit) return explicit;

  const fallback = normalizeDiscordToken(params.fallbackToken);
  if (!fallback) {
    throw new VaultDiscordClientError(
      `Discord bot token missing for account "${params.accountId}". ` +
        `Set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default.`,
      { code: "MISSING_TOKEN" },
    );
  }
  return fallback;
}

/**
 * Creates a Vault Discord client, reusing InfiniBot's existing patterns.
 *
 * The client uses:
 * - Account resolution from config/env
 * - Retry logic for rate limits
 * - The same REST client (@buape/carbon) as core InfiniBot
 */
export function createVaultDiscordClient(
  opts: VaultDiscordClientOpts = {},
  cfg: InfinibotConfig = loadConfig(),
): VaultDiscordClient {
  const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });

  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.token,
  });

  const rest = opts.rest ?? new RequestClient(token);

  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });

  return { rest, request, token, account };
}

/**
 * Gets just the REST client, for simple operations without retry wrapper.
 * Convenience function for single-shot API calls.
 */
export function getVaultDiscordRest(opts: VaultDiscordClientOpts = {}): RequestClient {
  return createVaultDiscordClient(opts).rest;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts Discord error code from various error formats.
 */
export function getDiscordErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;

  const candidate =
    "code" in err && err.code !== undefined
      ? err.code
      : "rawError" in err && err.rawError && typeof err.rawError === "object"
        ? (err.rawError as { code?: unknown }).code
        : undefined;

  if (typeof candidate === "number") return candidate;
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

/**
 * Wraps an error in a VaultDiscordClientError with appropriate code.
 */
export function wrapDiscordError(err: unknown, context: string): VaultDiscordClientError {
  if (err instanceof VaultDiscordClientError) return err;

  const discordCode = getDiscordErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);

  let code = "DISCORD_ERROR";
  if (discordCode === DISCORD_ERROR_CODES.MISSING_PERMISSIONS) {
    code = "MISSING_PERMISSIONS";
  } else if (discordCode === DISCORD_ERROR_CODES.UNKNOWN_MEMBER) {
    code = "MEMBER_NOT_FOUND";
  } else if (discordCode === DISCORD_ERROR_CODES.UNKNOWN_CHANNEL) {
    code = "CHANNEL_NOT_FOUND";
  } else if (discordCode === DISCORD_ERROR_CODES.UNKNOWN_ROLE) {
    code = "ROLE_NOT_FOUND";
  } else if (discordCode === DISCORD_ERROR_CODES.UNKNOWN_GUILD) {
    code = "GUILD_NOT_FOUND";
  } else if (discordCode === DISCORD_ERROR_CODES.CANNOT_DM_USER) {
    code = "CANNOT_DM_USER";
  }

  return new VaultDiscordClientError(`${context}: ${message}`, {
    code,
    discordCode,
    details: err,
  });
}

/**
 * Creates API options from common parameters.
 */
export function toApiOpts(accountId?: string): DiscordApiOpts {
  return accountId ? { accountId } : {};
}

// ============================================================================
// Shared Client Instance
// ============================================================================

let sharedClient: VaultDiscordClient | null = null;

/**
 * Gets or creates a shared client instance.
 * Useful for Vault operations that should share the same connection.
 *
 * @param opts - Options for client creation (only used if no shared client exists)
 * @param forceNew - Force creation of a new client, replacing the shared one
 */
export function getSharedVaultDiscordClient(
  opts: VaultDiscordClientOpts = {},
  forceNew = false,
): VaultDiscordClient {
  if (forceNew || !sharedClient) {
    sharedClient = createVaultDiscordClient(opts);
  }
  return sharedClient;
}

/**
 * Clears the shared client instance.
 * Call this if token changes or to force reconnection.
 */
export function clearSharedVaultDiscordClient(): void {
  sharedClient = null;
}

// ============================================================================
// Exports
// ============================================================================

export type { VaultDiscordClientOpts as ClientOpts };

/**
 * Runtime registry: accountId → botToken for per-agent Telegram bots.
 *
 * The TelegramBotRouter populates this at gateway startup when it finds agents
 * with `telegramBot.botToken` configured. The token resolver (`token.ts`) checks
 * this registry as a fallback so outbound replies from per-agent sessions are
 * sent via the correct bot without requiring entries in channels.telegram.accounts.
 *
 * AccountId convention: "agent-<agentId>" (e.g. agent "coder" → "agent-coder").
 */

type PerAgentBotEntry = {
  botToken: string;
  botUsername?: string;
};

const registry = new Map<string, PerAgentBotEntry>();

export function registerPerAgentBotToken(
  accountId: string,
  botToken: string,
  botUsername?: string,
): void {
  registry.set(accountId, { botToken, botUsername });
}

export function resolvePerAgentBotToken(accountId: string): string | undefined {
  return registry.get(accountId)?.botToken;
}

export function listPerAgentAccounts(): ReadonlyMap<string, PerAgentBotEntry> {
  return registry;
}

export function clearPerAgentRegistry(): void {
  registry.clear();
}

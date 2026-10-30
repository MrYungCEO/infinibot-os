/**
 * The one place the community bot token touches core config.
 *
 * Path (plan §6.5): `channels.discord.accounts.<accountId>.token`, plus
 * `intents.guildMembers = true` for that account only (never presence). This
 * is the key `src/discord/token.ts` resolves for a named account, and the
 * config redaction already masks `*token*` keys in config.get. A
 * `channels.discord.*` change hot-restarts the Discord channel only — no
 * gateway restart.
 *
 * The guild binding (`bindings[]`, routes that server to the `community`
 * agent) is a no-restart key too. `plugins.*` is never written here: that
 * prefix restarts the gateway.
 */

type AnyConfig = Record<string, any>;

export type AccountState = {
  tokenConfigured: boolean;
  tokenSource: string;
  enabled: boolean;
  guildMembersIntent: boolean;
  discordPluginEnabled: boolean;
};

export type ConfigWriter = {
  /** Current token for the community account, or null (never log it). */
  token(): string | null;
  account(): AccountState;
  saveToken(accountId: string, token: string, botName?: string): Promise<void>;
  bindGuild(accountId: string, guildId: string, agentId: string): Promise<void>;
};

export function createConfigWriter(deps: {
  loadConfig: () => AnyConfig;
  writeConfigFile: (cfg: AnyConfig) => Promise<void>;
  resolveAccount: (cfg: AnyConfig, accountId: string) => { enabled: boolean; token: string; tokenSource: string; guildMembersIntent: boolean };
  accountId: () => string;
}): ConfigWriter {
  return {
    token() {
      try {
        const acct = deps.resolveAccount(deps.loadConfig(), deps.accountId());
        return acct.token || null;
      } catch {
        return null;
      }
    },

    account() {
      const cfg = deps.loadConfig();
      const acct = deps.resolveAccount(cfg, deps.accountId());
      const entry = cfg.plugins?.entries?.discord;
      return {
        tokenConfigured: Boolean(acct.token),
        tokenSource: acct.token ? acct.tokenSource : "none",
        enabled: acct.enabled,
        guildMembersIntent: acct.guildMembersIntent,
        discordPluginEnabled: entry?.enabled === true,
      };
    },

    async saveToken(accountId, token, botName) {
      if (!token) throw new Error("token required");
      const cfg = deps.loadConfig();
      const channels = { ...cfg.channels };
      const discord = { ...channels.discord };
      const accounts = { ...discord.accounts };
      const prev = { ...accounts[accountId] };
      accounts[accountId] = {
        ...prev,
        ...(prev.name || !botName ? {} : { name: botName }),
        enabled: true,
        token,
        intents: { ...prev.intents, guildMembers: true },
      };
      discord.accounts = accounts;
      channels.discord = discord;
      await deps.writeConfigFile({ ...cfg, channels });
    },

    async bindGuild(accountId, guildId, agentId) {
      const cfg = deps.loadConfig();
      const bindings = (Array.isArray(cfg.bindings) ? cfg.bindings : []).filter(
        (b: AnyConfig) =>
          !(b?.agentId === agentId && b?.match?.channel === "discord" && (b?.match?.accountId ?? "") === accountId),
      );
      bindings.push({ agentId, match: { channel: "discord", accountId, guildId } });
      await deps.writeConfigFile({ ...cfg, bindings });
    },
  };
}

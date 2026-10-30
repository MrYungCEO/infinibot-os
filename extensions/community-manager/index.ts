/**
 * Community Manager — first-party InfiniBot plugin (manifest v2) that runs a
 * Discord community (first deployment: Young CEO Society). Plan:
 * ~/.infinibot/reports/discord-community-manager-agent-plan-2026-10-22.md.
 *
 * It reuses core's Discord stack rather than opening its own connection:
 *   - events come from the Discord monitor through the community event bus
 *     (`discordCommunity.onEvent`: joins, guild messages, `cm:` components)
 *   - REST goes through KinglyVault's Discord helpers (`discordCommunity.rest`)
 *   - approvals go to core's registry (`api.runtime.host.approvals`), so bans,
 *     kicks, long timeouts, mass DMs and @everyone show up in the dashboard,
 *     Telegram and mobile
 *
 * Contributes: the /community page + setup wizard (built into the control UI,
 * plugin-gated), `community-manager.*` RPCs, the `community` agent tool, the
 * `community` roster agent, one engine service and a setup check.
 *
 * Storage: `<stateDir>/plugin-data/community-manager/community.db`. The bot
 * token lives only in core config (`channels.discord.accounts.<id>.token`).
 *
 * Gating (plan §8): the plugin installs free for everyone; Pro features are
 * flagged off unless a KinglyVault entitlement for `community-manager` (or a
 * plan such as CEO) or the owner grant is present — the owner install is
 * exempt through the signed owner grant.
 */

import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";
import { discordCommunity, pluginEntitlementFor } from "infinibot/plugin-sdk";

import { ApprovalGate, type ApprovalsLike } from "./src/approval-gate.js";
import { PLUGIN_ID } from "./src/contract.js";
import { CommunityEngine } from "./src/engine.js";
import { createCommunityHandlers } from "./src/rpc.js";
import { CommunityStore, communityDataDir } from "./src/store.js";
import { createConfigWriter } from "./src/token-config.js";
import { createCommunityTool } from "./src/tool.js";

export default function register(api: InfiniBotPluginApi) {
  const host = api.runtime.host;
  const log = { info: (m: string) => api.logger.info(m), warn: (m: string) => api.logger.warn(m) };

  let store: CommunityStore | null = null;
  const getStore = () => {
    store ??= new CommunityStore(`${communityDataDir(api.runtime.state.resolveStateDir())}/community.db`);
    return store;
  };

  const config = createConfigWriter({
    loadConfig: () => api.runtime.config.loadConfig() as Record<string, any>,
    writeConfigFile: (cfg) => api.runtime.config.writeConfigFile(cfg as never),
    resolveAccount: (cfg, accountId) => discordCommunity.resolveAccount(cfg as never, accountId),
    accountId: () => getStore().getSettings().accountId,
  });

  const approvals = (host?.approvals ?? null) as unknown as ApprovalsLike | null;
  const gate = new ApprovalGate(approvals);

  let engine: CommunityEngine | null = null;
  const getEngine = () => {
    engine ??= new CommunityEngine({
      store: getStore(),
      rest: discordCommunity.rest,
      gate,
      token: () => config.token(),
      alertOwner: host?.alertOwner ?? null,
      log,
      snowflakeToMs: discordCommunity.snowflakeToMs,
    });
    return engine;
  };
  let listening = false;

  const handlers = createCommunityHandlers({
    store: getStore,
    engine: getEngine,
    rest: discordCommunity.rest,
    config,
    normalizeToken: discordCommunity.normalizeToken,
    intentsFromFlags: discordCommunity.intentsFromFlags,
    pro: () => {
      const ent = pluginEntitlementFor(PLUGIN_ID, Date.now(), { wildcard: true });
      return ent.state === "valid" || ent.state === "grace"
        ? { unlocked: true, source: ent.source }
        : { unlocked: false, source: null };
    },
    pendingApprovals: () =>
      (host?.approvals?.list({ status: "pending" }) ?? [])
        .filter((r) => r.sourceRef?.plugin === PLUGIN_ID)
        .map((r) => ({ id: r.id, title: r.title, summary: r.summary, createdAt: r.createdAt, sourceRef: r.sourceRef })),
    listening: () => listening,
  });
  for (const [method, handler] of Object.entries(handlers)) {
    api.registerGatewayMethod(method, handler);
  }

  api.registerTool(() => createCommunityTool(getEngine), { name: "community" });

  api.registerSetupCheck({
    id: "community-manager.connected",
    evaluate: () => {
      const s = getStore().getSettings();
      const acct = config.account();
      if (!acct.tokenConfigured) return { state: "needs-setup", reason: "Connect your Discord bot to start the Community Manager." };
      if (!s.guildId) return { state: "needs-setup", reason: "Pick the Discord server the Community Manager runs." };
      if (s.mode === "setup") return { state: "needs-setup", reason: "Finish the Community Manager setup and go live." };
      return { state: "ready" };
    },
  });

  api.registerService({
    id: "community-manager-engine",
    start: () => {
      getEngine().start((fn) => discordCommunity.onEvent(fn));
      listening = true;
      log.info("community-manager: engine listening for Discord community events");
    },
    stop: () => {
      engine?.stop();
      listening = false;
      store?.close();
      store = null;
      engine = null;
    },
  });
}

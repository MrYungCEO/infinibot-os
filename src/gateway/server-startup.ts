import os from "node:os";
import path from "node:path";

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startGmailWatcher } from "../hooks/gmail-watcher.js";
import { initGmail } from "./server-methods/gmail.js";
import { initCalendar } from "./server-methods/calendar-sync.js";
import { startInboundManager } from "../services/email/inbound-manager.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import type { loadInfiniBotPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { startPluginUpdateChecker } from "./plugin-update-checker.js";
import { startEntitlementRefreshLoop } from "./server-methods/plugins-catalog.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { runMcpServer } from "../mcp/server.js";
import { startMCPServers } from "../mcp/client.js";
import {
  isInfinibotRegisteredInClaudeCode,
  registerInfinibotInClaudeCode,
} from "../mcp/claude-code-register.js";
import { startWhenConfigured } from "./integration-poller-gate.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { startCloudflareTunnel, isCloudflaredAvailable } from "./server-cloudflare-tunnel.js";
import { initAutoUpdateServer, type AutoUpdateServer } from "../infra/auto-update.js";
import {
  startClaudeCodeWatcherIfEnabled,
  type ClaudeCodeWatcherHandle,
} from "./claude-code-watcher.js";

// Notification sidecars — wired here so they start once per gateway process.
import { startMobilePushDispatcher } from "../notifications/mobile-push.js";
import { startTelegramCompletions } from "../notifications/telegram-completions.js";
import { startKanbanDueSweep } from "../notifications/kanban-due-sweep.js";
import { startStaleTaskSweep } from "../notifications/stale-task-sweep.js";
import { startArtifactDelivery } from "../agents/artifact-delivery.js";
import { telegramBotRouter } from "../telegram/bot-router.js";
import { startWorkflowEngine } from "./workflow-engine.js";

/** True when Claude Code's user config (current or legacy path) already lists infinibot. */
function claudeCodeEntryExists(): boolean {
  try {
    if (isInfinibotRegisteredInClaudeCode().registered) return true;
    return isInfinibotRegisteredInClaudeCode({
      configPath: path.join(os.homedir(), ".claude", "mcp.json"),
    }).registered;
  } catch {
    return false;
  }
}

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  resolvedAuth?: ResolvedGatewayAuth;
  pluginRegistry: ReturnType<typeof loadInfiniBotPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  // One-shot voice config migration: forward a CLI-onboarded infinibot.json::
  // voice block into the runtime voice.json when the latter is absent. Idempotent
  // and non-fatal — a present voice.json short-circuits.
  try {
    const { migrateInfinibotVoiceToRuntime } = await import("../voice/config.js");
    if (migrateInfinibotVoiceToRuntime()) {
      params.logHooks.info("[voice-setup] migrated legacy voice config → voice.json");
    }
  } catch (err) {
    params.log.warn(`[voice-setup] voice config migration failed: ${String(err)}`);
  }

  // Start notification sidecars (mobile push + agent-completion Telegram + kanban due sweep).
  // All are idempotent and non-fatal; gateway continues regardless.
  // (Discipline block alerts moved into the Discipline plugin's service.)
  try {
    startMobilePushDispatcher();
    params.logHooks.info("mobile push dispatcher started");
  } catch (err) {
    params.log.warn(`mobile push dispatcher failed to start: ${String(err)}`);
  }
  try {
    // Was armed as an import side effect of the old core discipline handlers.
    // Sends only while a day-planner provider (Discipline plugin) supplies a target.
    startTelegramCompletions();
    params.logHooks.info("telegram completion notifier started");
  } catch (err) {
    params.log.warn(`telegram completion notifier failed to start: ${String(err)}`);
  }
  try {
    startKanbanDueSweep();
    params.logHooks.info("kanban due sweep started");
  } catch (err) {
    params.log.warn(`kanban due sweep failed to start: ${String(err)}`);
  }
  try {
    startStaleTaskSweep();
    params.logHooks.info("stale task sweep started");
  } catch (err) {
    params.log.warn(`stale task sweep failed to start: ${String(err)}`);
  }
  try {
    startArtifactDelivery();
    params.logHooks.info("artifact telegram delivery watcher started");
  } catch (err) {
    params.log.warn(`artifact telegram delivery failed to start: ${String(err)}`);
  }
  try {
    // Daily branch-health scan — REPORT ONLY, off until the owner enables it
    // on the Repos page (registry scan.daily). Never deletes anything.
    const { startRepoHealthScheduler } = await import("../projects/repos/service.js");
    startRepoHealthScheduler({ warn: params.log.warn });
  } catch (err) {
    params.log.warn(`repo health scheduler failed to start: ${String(err)}`);
  }
  try {
    startWorkflowEngine();
    params.logHooks.info("proactive workflow engine started");
  } catch (err) {
    params.log.warn(`proactive workflow engine failed to start: ${String(err)}`);
  }

  // Per-agent Telegram bot router — starts independent long-poll loops for any
  // agent that has agents.list[].telegramBot.botToken configured. Skipped when
  // INFINIBOT_SKIP_CHANNELS=1 (same flag that suppresses the main channel start).
  if (!isTruthyEnvValue(process.env.INFINIBOT_SKIP_CHANNELS)) {
    try {
      telegramBotRouter.start({ cfg: params.cfg });
      params.logHooks.info("per-agent telegram bot router started");
    } catch (err) {
      params.log.warn(`per-agent telegram bot router failed to start: ${String(err)}`);
    }
  }

  // Instagram background sync moved to the content-studio plugin (service
  // "content-studio-instagram-sync"); it no longer starts from core.

  // Eagerly initialize the autonomy system so its internal heartbeat timer
  // (HEARTBEAT_INTERVAL_MS) starts at boot, rather than waiting for the first
  // autonomy RPC to lazily call initAutonomy() via getAutonomy(). Without this
  // the heartbeat never ticks unless the operator opens the autonomy UI. The
  // lazy path in server-methods/autonomy.ts stays as a safety net (initAutonomy
  // short-circuits after the first call), and re-applies the latest Telegram
  // config on each RPC. Non-fatal: a failure here must not crash boot.
  try {
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const { initAutonomy } = await import("../autonomy/index.js");
    const chatIdRaw = params.cfg.channels?.telegram?.allowFrom?.[0];
    const telegramConfig =
      params.cfg.channels?.telegram?.botToken && chatIdRaw
        ? {
            botToken: params.cfg.channels.telegram.botToken,
            chatId: String(chatIdRaw),
          }
        : undefined;
    await initAutonomy(stateDir, {}, telegramConfig);
    params.logHooks.info("autonomy system initialized (heartbeat started)");
  } catch (err) {
    params.log.warn(`autonomy system failed to initialize: ${String(err)}`);
  }

  // Start clawd browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Initialize Gmail API credentials from config (integrations.calendar).
  // Never log the integrations block itself: it carries OAuth client secrets
  // and refresh tokens. Account ids are enough to debug which accounts loaded.
  {
    const gmailAccounts = (params.cfg as any).integrations?.gmail?.accounts;
    const ids = Array.isArray(gmailAccounts)
      ? gmailAccounts.map((a: { id?: unknown }) => String(a?.id ?? "?"))
      : [];
    const suffix = ids.length ? `: ${ids.join(", ")}` : "";
    params.logHooks.info(`gmail: ${ids.length} configured account(s)${suffix}`);
  }
  initGmail({ config: params.cfg as any });

  // Wire the same Google OAuth credentials into the agent calendar tool so
  // agents can create/update/move events. No-op + warn if not connected.
  try {
    initCalendar({ config: params.cfg as any });
  } catch (err) {
    params.logHooks.warn(`calendar tool init failed: ${String(err)}`);
  }

  // Start IMAP inbound listeners for every enabled smtp-imap account.
  // Broadcasting hooks are wired later in server-http; pass null and the
  // manager just persists messages without realtime notifications.
  if (!isTruthyEnvValue(process.env.INFINIBOT_SKIP_EMAIL_INBOUND)) {
    try {
      await startInboundManager(null);
    } catch (err) {
      params.logHooks.warn(`email inbound manager failed to start: ${String(err)}`);
    }
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  if (!isTruthyEnvValue(process.env.INFINIBOT_SKIP_GMAIL_WATCHER)) {
    try {
      const gmailResult = await startGmailWatcher(params.cfg);
      if (gmailResult.started) {
        params.logHooks.info("gmail watcher started");
      } else if (
        gmailResult.reason &&
        gmailResult.reason !== "hooks not enabled" &&
        gmailResult.reason !== "no gmail account configured"
      ) {
        params.logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
      }
    } catch (err) {
      params.logHooks.error(`gmail watcher failed to start: ${String(err)}`);
    }
  }

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via INFINIBOT_SKIP_CHANNELS (or legacy INFINIBOT_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.INFINIBOT_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.INFINIBOT_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (INFINIBOT_SKIP_CHANNELS=1 or INFINIBOT_SKIP_PROVIDERS=1)",
    );
  }

  // Notion ↔ local bidirectional sync. The push half is wired into kanban
  // writes (`kanban-store-ops.mirrorProjectToNotion`); this starts the
  // pull half so user-made Notion edits flow back into local SQLite.
  // Gated by env so tests / single-shot CLI runs can skip the timer.
  void startWhenConfigured({
    name: "notion bidirectional sync",
    isConfigured: async () => {
      const { getNotionApiKeyOrNull, getNotionConfig } =
        await import("../databases/notion-config.js");
      return getNotionConfig().syncMode !== "off" && getNotionApiKeyOrNull() !== null;
    },
    start: async () => {
      const { startNotionBidirectionalSync } =
        await import("../databases/notion-bidirectional-sync.js");
      startNotionBidirectionalSync();
      // Resume kanban writes still owed to Notion (made while it was down).
      const { startNotionOutbox } = await import("../databases/kanban-store-ops.js");
      startNotionOutbox();
    },
    log: { info: params.logHooks.info, warn: params.log.warn },
  });

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  // Registry update check for installed plugins (badge on Setup › Plugins).
  startPluginUpdateChecker({ info: params.logHooks.info, warn: params.log.warn });
  // KinglyVault plugin entitlements: refresh the signed token every 12 h.
  startEntitlementRefreshLoop();

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  // Start standalone MCP bridge for Kanban/Projects (Port 8889)
  if (!isTruthyEnvValue(process.env.INFINIBOT_SKIP_MCP)) {
    try {
      const mcpPort = Number(process.env.INFINIBOT_MCP_PORT) || 8889;
      const gatewayPort = Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
      const tlsEnabled = params.cfg.gateway?.tls?.enabled === true;
      const protocol = tlsEnabled ? "wss" : "ws";

      const authMode = params.resolvedAuth?.mode;

      void runMcpServer({
        httpPort: mcpPort,
        gatewayUrl: `${protocol}://127.0.0.1:${gatewayPort}`,
        // Only pass token if we are strictly in token mode, otherwise it overrides password in mcp/server.ts
        gatewayToken:
          authMode === "token"
            ? params.resolvedAuth?.token || params.cfg.gateway?.auth?.token
            : undefined,
        gatewayPassword: params.resolvedAuth?.password,
        verbose: false,
        // Allow self-signed certs for local loopback connection
        rejectUnauthorized: tlsEnabled ? false : undefined,
      })
        .then((handle) => {
          params.logHooks.info(`MCP standalone bridge running on port ${handle.port}`);
        })
        .catch((err) => {
          params.log.warn(`MCP server sidecar failed: ${String(err)}`);
        });
    } catch (err) {
      params.log.warn(`failed to initialize MCP sidecar: ${String(err)}`);
    }
  }

  // Keep the infinibot entry in Claude Code's config (~/.claude.json and
  // ~/.claude/mcp.json) in sync so a `claude` CLI sees the gateway tools.
  // Writing into another tool's config (with a credential) is opt-in: we only
  // CREATE the entry when INFINIBOT_CLAUDE_CODE_REGISTER=1 or the user clicked
  // Settings → MCP → Register. An entry that already exists is refreshed, so
  // installs that were registered before keep working unchanged.
  if (
    !isTruthyEnvValue(process.env.INFINIBOT_SKIP_CLAUDE_CODE_REGISTER) &&
    (isTruthyEnvValue(process.env.INFINIBOT_CLAUDE_CODE_REGISTER) || claudeCodeEntryExists())
  ) {
    try {
      const gatewayPort = Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
      const tlsEnabled = params.cfg.gateway?.tls?.enabled === true;
      const protocol = tlsEnabled ? "wss" : "ws";
      const authMode = params.resolvedAuth?.mode;
      const result = registerInfinibotInClaudeCode({
        gatewayUrl: `${protocol}://127.0.0.1:${gatewayPort}`,
        gatewayToken:
          authMode === "token"
            ? params.resolvedAuth?.token || params.cfg.gateway?.auth?.token
            : undefined,
        gatewayPassword:
          authMode === "password"
            ? params.resolvedAuth?.password || params.cfg.gateway?.auth?.password
            : undefined,
      });
      if (result.changed) {
        params.logHooks.info(`auto-registered infinibot MCP entry at ${result.path}`);
      }
    } catch (err) {
      params.log.warn(`claude-code MCP auto-register failed: ${String(err)}`);
    }
  }

  // Start external MCP servers (from ~/.claude/mcp.json and state/mcp-servers.json)
  if (!isTruthyEnvValue(process.env.INFINIBOT_SKIP_MCP_CLIENTS)) {
    try {
      await startMCPServers();
      params.logHooks.info("external MCP servers started");
    } catch (err) {
      params.log.warn(`external MCP servers failed to start: ${String(err)}`);
    }
  }

  // Discovery Docs — Netlify submission poller. Pulls form submissions
  // into our local DB on a cron so we never have to expose the gateway
  // inbound to the internet. No-op when no Netlify token is configured.
  void startWhenConfigured({
    name: "discovery: Netlify poller",
    isConfigured: async () => {
      const { getNetlifyToken } = await import("../discovery/secrets.js");
      const { STATE_DIR } = await import("../config/paths.js");
      return getNetlifyToken(STATE_DIR) !== null;
    },
    start: async () => {
      const { startNetlifyPoller } = await import("../discovery/netlify-poller.js");
      startNetlifyPoller({
        lookupBusiness: (businessId) => {
          try {
            const fs = require("node:fs") as typeof import("node:fs");
            const pth = require("node:path") as typeof import("node:path");
            const { STATE_DIR } =
              require("../config/paths.js") as typeof import("../config/paths.js");
            const path = pth.join(STATE_DIR, "business.json");
            if (!fs.existsSync(path)) return null;
            const data = JSON.parse(fs.readFileSync(path, "utf-8")) as {
              businesses?: Array<{
                id: string;
                name: string;
                industry?: string;
                [k: string]: unknown;
              }>;
            };
            return data.businesses?.find((b) => b.id === businessId) ?? null;
          } catch {
            return null;
          }
        },
      });
    },
    log: { info: params.logHooks.info, warn: params.log.warn },
  });

  // Loops.so periodic CRM → contacts sync. Driven by config.loops.autoSyncMinutes;
  // 0/unset = manual only. Wrapping in an IIFE so a Loops outage can't block
  // gateway startup, and using setInterval rather than cron because the cadence
  // is a low-precision "every N minutes" — no calendar semantics needed.
  const loopsSyncMinutes = (params.cfg as { loops?: { autoSyncMinutes?: number } }).loops
    ?.autoSyncMinutes;
  if (typeof loopsSyncMinutes === "number" && loopsSyncMinutes > 0) {
    const intervalMs = Math.max(1, loopsSyncMinutes) * 60_000;
    const runOnce = async () => {
      try {
        const cfg = (params.cfg as { loops?: { apiKey?: string } }).loops;
        if (!cfg?.apiKey) return;
        const { getLoopsClient } = await import("../loops/client.js");
        const { getDatabasesStore } = await import("../databases/store.js");
        const { syncCrmContactsToLoops } = await import("../loops/crm-sync.js");
        const client = getLoopsClient(cfg.apiKey);
        if (!client) return;
        const store = getDatabasesStore();
        const result = await syncCrmContactsToLoops(client, store);
        params.logHooks.info(
          `loops auto-sync: ${result.upserted}/${result.attempted} upserted, ${result.failed.length} failed`,
        );
      } catch (err) {
        params.log.warn(`loops auto-sync failed: ${(err as Error).message}`);
      }
    };
    setInterval(() => void runOnce(), intervalMs).unref();
    // Run once on boot too, after a short delay so the gateway is fully up.
    setTimeout(() => void runOnce(), 30_000).unref();
    params.logHooks.info(`loops auto-sync enabled — every ${loopsSyncMinutes}m`);
  }

  // Cumulative-skills self-improve pass. Trajectories accumulate via the
  // pi-embedded-runner; this scheduler periodically reflects on recent runs
  // and refines learned skills whose usage has crossed the configured
  // threshold. Gated by INFINIBOT_SELF_IMPROVE_INTERVAL_MIN — set 0 / unset
  // to disable (the trajectory log keeps filling regardless).
  const selfImproveMin = Number(process.env.INFINIBOT_SELF_IMPROVE_INTERVAL_MIN ?? 0);
  if (Number.isFinite(selfImproveMin) && selfImproveMin > 0) {
    const intervalMs = Math.max(5, selfImproveMin) * 60_000;
    const defaultModel =
      (params.cfg as { agents?: { defaults?: { model?: { default?: string } } } }).agents?.defaults
        ?.model?.default ?? "anthropic:claude-sonnet-4-6";
    const runOnce = async () => {
      try {
        const { generateDocument } = await import("../discovery/ai.js");
        const { runSelfImprovePass, resolveCumulativeSkillsConfig } =
          await import("../agents/skills/cumulative/index.js");
        const config = resolveCumulativeSkillsConfig();
        if (!config.enabled) return;
        const complete = async (p: { system: string; user: string; maxOutputTokens?: number }) => {
          const res = await generateDocument({
            model: defaultModel,
            systemPrompt: p.system,
            userPrompt: p.user,
            temperature: 0.2,
            maxTokens: p.maxOutputTokens ?? 2000,
            timeoutMs: 60_000,
          });
          return res.text;
        };
        const agentIdForLookup = process.env.INFINIBOT_SELF_IMPROVE_AGENT_ID?.trim() || "default";
        const results = await runSelfImprovePass(config, { complete, agentIdForLookup });
        const refined = results.filter((r) => r.outcome === "rewrote").length;
        if (refined > 0) {
          params.logHooks.info(
            `cumulative-skills self-improve: refined ${refined}/${results.length} skill(s)`,
          );
        }
      } catch (err) {
        params.log.warn(`cumulative-skills self-improve failed: ${(err as Error).message}`);
      }
    };
    setInterval(() => void runOnce(), intervalMs).unref();
    // Defer first pass by a couple minutes so boot stays cold-start fast.
    setTimeout(() => void runOnce(), 120_000).unref();
    params.logHooks.info(
      `cumulative-skills self-improve enabled — every ${selfImproveMin}m using ${defaultModel}`,
    );
  }

  // Cross-session full-text search indexer. Walks every agent's sessions
  // directory, ingests new JSONL tail bytes into a SQLite FTS5 index, and
  // surfaces results via the `sessions.search` RPC. Cheap by design — only
  // the appended bytes are re-read each pass, so a 1-min cadence stays well
  // under 1% of a core on typical workspaces.
  void (async () => {
    try {
      const { ingestSessions } = await import("../sessions/search-index.js");
      const seed = ingestSessions();
      if (seed.messagesIndexed > 0) {
        params.logHooks.info(
          `sessions search: seeded ${seed.messagesIndexed} message(s) from ${seed.filesUpdated}/${seed.filesScanned} file(s)`,
        );
      }
    } catch (err) {
      params.log.warn(`sessions search seed failed: ${(err as Error).message}`);
    }
  })();
  const sessionsSearchTick = async () => {
    try {
      const { ingestSessions } = await import("../sessions/search-index.js");
      ingestSessions();
    } catch (err) {
      params.log.warn(`sessions search ingest failed: ${(err as Error).message}`);
    }
  };
  setInterval(() => void sessionsSearchTick(), 60_000).unref();

  // Start Cloudflare Tunnel if enabled in config
  const tunnelConfig = params.cfg.gateway?.tunnel;
  if (tunnelConfig?.enabled && !isTruthyEnvValue(process.env.INFINIBOT_SKIP_TUNNEL)) {
    const gatewayPort = Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
    const tlsEnabled = params.cfg.gateway?.tls?.enabled === true;
    const protocol = tlsEnabled ? "https" : "http";

    void (async () => {
      const available = await isCloudflaredAvailable();
      if (!available) {
        params.log.warn("cloudflare tunnel enabled but cloudflared not found in PATH");
        return;
      }

      params.logHooks.info("starting cloudflare tunnel...");
      const result = await startCloudflareTunnel({ port: gatewayPort, protocol });

      if (result.url) {
        params.logHooks.info(`cloudflare tunnel running: ${result.url}`);
      } else if (result.error) {
        params.log.warn(`cloudflare tunnel failed: ${result.error}`);
      }
    })();
  }

  // Watch ~/.claude/projects/**/*.jsonl so Claude Code sessions started in
  // any terminal on this box show up live on the activity page. Read-only on
  // ~/.claude/. Disable with INFINIBOT_SKIP_CLAUDE_CODE_WATCHER=1.
  let claudeCodeWatcher: ClaudeCodeWatcherHandle | null = null;
  try {
    claudeCodeWatcher = startClaudeCodeWatcherIfEnabled();
  } catch (err) {
    params.log.warn(`claude-code transcript watcher failed to start: ${String(err)}`);
  }

  // Initialize Auto-Update Server
  let autoUpdateServer: AutoUpdateServer | null = null;
  if (!isTruthyEnvValue(process.env.INFINIBOT_SKIP_AUTO_UPDATE)) {
    try {
      autoUpdateServer = initAutoUpdateServer({
        config: params.cfg.update?.auto,
        infinibotConfig: params.cfg,
        logger: {
          info: (msg) => params.logHooks.info(`[auto-update] ${msg}`),
          warn: (msg) => params.log.warn(`[auto-update] ${msg}`),
          error: (msg) => params.logHooks.error(`[auto-update] ${msg}`),
        },
      });
      void autoUpdateServer
        .start()
        .then(() => {
          if (params.cfg.update?.auto?.enabled) {
            params.logHooks.info("auto-update server started");
          }
        })
        .catch((err) => {
          params.log.warn(`auto-update server failed to start: ${String(err)}`);
        });
    } catch (err) {
      params.log.warn(`failed to initialize auto-update server: ${String(err)}`);
    }
  }

  // GitHub project sync — every 10 minutes, check all projects that have
  // githubLocalPath configured and update githubSyncStatus. Emits a kanban
  // notification when a project goes from clean → behind or conflict.
  // Starts once any project has a local GitHub checkout linked.
  void startWhenConfigured({
    name: "github project sync (every 10m)",
    isConfigured: async () => {
      const { getKanbanStore } = await import("../tasks/store.js");
      return Object.values(getKanbanStore().getAllProjectMeta()).some((meta) =>
        Boolean(meta.githubLocalPath),
      );
    },
    start: () => {
      const INTERVAL_MS = 10 * 60_000;
      const runOnce = async () => {
        try {
          const { startGitHubProjectSyncPass } = await import("./github-project-sync-job.js");
          await startGitHubProjectSyncPass();
        } catch (err) {
          params.log.warn(`github project sync pass failed: ${(err as Error).message}`);
        }
      };
      // First pass after 2 min (let gateway fully boot first).
      setTimeout(() => void runOnce(), 2 * 60_000).unref();
      setInterval(() => void runOnce(), INTERVAL_MS).unref();
    },
    log: { info: params.logHooks.info, warn: params.log.warn },
  });

  return { browserControl, pluginServices, autoUpdateServer, claudeCodeWatcher };
}

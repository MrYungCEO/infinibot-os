import { startLocalRuntimeManager } from "../local-runtimes/runtime.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initCalendarAlerts, startAlertsRunner } from "../calendar/alerts.js";
import { startOcrWorker } from "../ocr/runtime.js";
import { startVideoAnalysis } from "../media/video-analysis/runtime.js";
// Import to ensure the global __infinibotUIBroadcast type declaration is loaded
import type { UIBroadcastMessage } from "../federation/event-bus.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createDefaultDeps } from "../cli/deps.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  CONFIG_PATH,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { applyCoreSurfacePluginMigrations } from "../plugins/core-surface-migrations.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSharedDir, resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { fleetTenantStateDirs } from "../saas/fleet-tenant.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureInfiniBotCliOnPath } from "../infra/path-env.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import { setGatewaySigusr1RestartPolicy } from "../infra/restart.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { RuntimeEnv } from "../runtime.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import type { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { createChannelManager } from "./server-channels.js";
import { fleetHostedChannelPlugins } from "../saas/fleet-channels.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { buildGatewayCronService } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { NodeRegistry } from "./node-registry.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";
import { loadGatewayPlugins } from "./server-plugins.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { hasConnectedMobileNode } from "./server-mobile-nodes.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { startGatewaySidecars } from "./server-startup.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { startGatewayTailscaleExposureDetached } from "./server-tailscale.js";
import { resolveTailscaleExposurePlan } from "./tailscale-config.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import { initializeTerminalManager, setTerminalBroadcaster } from "./server-methods/terminal.js";
import { setUIControlBroadcaster } from "./server-methods/ui-control.js";
import { setOverlayBroadcaster } from "../overlay/router.js";
import { setSubagentBroadcaster } from "../agents/coder-runtime/subagent-broadcast.js";
import { setVerificationBroadcaster } from "../verification/notify.js";
import { setReviewBroadcaster } from "../verification/review-thread.js";
import {
  refreshScreenshotIndex,
  setScreenshotBroadcaster,
} from "../verification/screenshot-index.js";
import { setNotificationBroadcaster } from "../notifications/emit.js";
import { setFederationEventBroadcaster } from "../federation/events.js";
import { setSSHEventBroadcaster } from "../ssh-devices/events.js";
import { setClientsBroadcaster } from "./server-methods/clients.js";
import { setCommsBroadcaster } from "./server-methods/comms.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureInfiniBotCliOnPath();

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const canvasRuntime = runtimeForLogger(logCanvas);

export type GatewayServer = {
  /** The primary host the server bound to (e.g. "127.0.0.1", "0.0.0.0", a tailnet IP). */
  bindHost: string;
  /**
   * All hosts the HTTP server actually bound to. For a specific non-loopback
   * bind this includes loopback aliases (127.0.0.1/::1) so a local browser can
   * reach the Control UI over a secure context.
   */
  bindHosts: string[];
  /** The port the server bound to. */
  port: number;
  /** Normalized Control UI base path (e.g. "" or "/ui"). */
  controlUiBasePath: string;
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Federation override (CLI flags). Merges into `cfg.federation` at startup
   * so `--master-mode --federation-port 47913` actually starts the
   * `FederationHub` without requiring a config-file edit.
   */
  federationOverride?: {
    enabled?: boolean;
    mode?: "master" | "satellite" | "standalone";
    federationPort?: number;
    masterUrl?: string;
    masters?: string[];
    masterFailoverTimeoutMs?: number;
  };
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the onboarding wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // Ensure all default port derivations (browser/canvas) see the actual runtime port.
  process.env.INFINIBOT_GATEWAY_PORT = String(port);

  // Point the data layer at the active profile BEFORE any store opens, so
  // the first DB handle resolves to the correct per-user data dir. For the
  // "default" profile this is a no-op (data dir === shared root). Shared
  // services (config, credentials, plugins, mcp) always use the shared root.
  try {
    const { initCurrentUserFromRegistry } = await import("../users/profiles.js");
    initCurrentUserFromRegistry();
  } catch (err) {
    log.warn?.(`gateway: profile init skipped: ${String((err as Error)?.message ?? err)}`);
  }
  // Hosted fleet: a tenant Machine's global user is its one tenant, so plugin
  // services / timers / Bearer HTTP routes use the same data dir as its RPCs.
  if (process.env.FLEET_TENANT_ID?.trim()) {
    try {
      const { applyFleetTenantNamespace } = await import("../saas/fleet-tenant.js");
      const ns = applyFleetTenantNamespace();
      log.info?.(`gateway: fleet tenant namespace ${ns ? "pinned" : "not known yet"}`);
    } catch (err) {
      log.warn?.(`gateway: fleet tenant namespace skipped: ${String(err)}`);
    }
  }
  logAcceptedEnvOption({
    key: "INFINIBOT_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "INFINIBOT_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });

  let configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    if (!migrated) {
      throw new Error(
        `Legacy config entries detected but auto-migration failed. Run "${formatCliCommand("infinibot doctor")}" to migrate.`,
      );
    }
    await writeConfigFile(migrated);
    if (changes.length > 0) {
      log.info(
        `gateway: migrated legacy config entries:\n${changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    }
  }

  configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.exists && !configSnapshot.valid) {
    const issues =
      configSnapshot.issues.length > 0
        ? configSnapshot.issues
            .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
            .join("\n")
        : "Unknown validation issue.";
    throw new Error(
      `Invalid config at ${configSnapshot.path}.\n${issues}\nRun "${formatCliCommand("infinibot doctor")}" to repair, then retry.`,
    );
  }

  // Hosted fleet: the tenant's data lives in <shared>/users/<ns> (written
  // inside request scopes); boot runs unscoped, so point the data checks there.
  const tenantStateDirs = fleetTenantStateDirs(resolveSharedDir());
  const autoEnable = applyPluginAutoEnable({
    config: configSnapshot.config,
    env: process.env,
    stateDir: resolveStateDirWithLegacyEnv(),
    extraStateDirs: tenantStateDirs,
    hostedChannels: fleetHostedChannelPlugins(),
  });
  if (autoEnable.changes.length > 0) {
    try {
      await writeConfigFile(autoEnable.config);
      log.info(
        `gateway: auto-enabled plugins:\n${autoEnable.changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    } catch (err) {
      log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    }
  }

  // Core surfaces that became first-party plugins (Discipline, Canvas
  // Library): keep them ON for installs that already have data
  // (plugins/core-surface-migrations.ts). Products + Whiteboard are kept on by
  // applyPluginAutoEnable above; Content Studio by its own migration below.
  try {
    const surfaceMigration = applyCoreSurfacePluginMigrations({
      config: autoEnable.changes.length > 0 ? autoEnable.config : configSnapshot.config,
      stateDir: resolveStateDir(),
      extraDataDirs: tenantStateDirs,
    });
    if (surfaceMigration.changes.length > 0) {
      await writeConfigFile(surfaceMigration.config);
      log.info(
        `gateway: plugin migrations:\n${surfaceMigration.changes.map((c) => `- ${c}`).join("\n")}`,
      );
    }
  } catch (err) {
    log.warn(`gateway: plugin migrations failed: ${String(err)}`);
  }
  // Models retired upstream (e.g. ollama-cloud/kimi-k2.5 → HTTP 410): rewrite
  // the configured refs to their replacement so every turn doesn't have to
  // self-heal. writeConfigFile keeps *.bak backups. See
  // config/retired-models-migration.ts.
  try {
    const { persistRetiredModelMigration } = await import("../config/retired-models-migration.js");
    const retiredChanges = await persistRetiredModelMigration();
    if (retiredChanges.length > 0) {
      log.warn(
        `gateway: replaced retired models in config (backup: *.bak):\n${retiredChanges
          .map((c) => `- ${c}`)
          .join("\n")}`,
      );
    }
  } catch (err) {
    log.warn(`gateway: retired-model migration failed: ${String(err)}`);
  }
  // ── content-studio plugin: one-time enablement migration ──────────────────
  // Content Studio left core for a bundled (default-off) plugin. Installs
  // that already have content data keep it on; everyone else starts off.
  // See src/content-studio/migration.ts.
  try {
    const snap = await readConfigFileSnapshot();
    if (!snap.exists || snap.valid) {
      const { migrateContentStudioEnablement } = await import("../content-studio/migration.js");
      const { contentLegacyStateDir } = await import("../content-studio/runtime.js");
      const { resolvePluginDataDir } = await import("../plugins/plugin-data.js");
      const { resolveStateDir } = await import("../config/paths.js");
      const res = migrateContentStudioEnablement({
        config: snap.exists ? snap.config : ({} as typeof snap.config),
        pluginDataDir: resolvePluginDataDir("content-studio"),
        stateDirs: [resolveStateDir(), contentLegacyStateDir(), ...tenantStateDirs],
      });
      if (res.changed) await writeConfigFile(res.config);
      if (res.summary) log.info(`gateway: ${res.summary}`);
    }
  } catch (err) {
    log.warn(`gateway: content-studio migration failed: ${String(err)}`);
  }
  // ── end content-studio ─────────────────────────────────────────────────────

  // Business HQ progress: one-time correction for past bulk completions (a
  // script closing hundreds of stale tasks must not read as progress). Core
  // owns hq-progress.json, so this runs whether or not the business-agency
  // plugin is on. Idempotent (keyed by task-id-set hash); never deletes
  // events; never throws. See src/hq-progress/bulk-correction.ts.
  try {
    const { runHqBulkCorrectionMigration, describeHqBulkCorrection } =
      await import("../hq-progress/bulk-correction.js");
    for (const r of runHqBulkCorrectionMigration()) {
      const line = describeHqBulkCorrection(r);
      if (!line) continue;
      if (r.status === "applied") log.info(`gateway: ${line}`);
      else log.warn(`gateway: ${line}`);
    }
  } catch (err) {
    log.warn(`gateway: hq-progress bulk correction failed: ${String(err)}`);
  }

  // Seed + refresh the standard agent agency on every boot.
  // - Inserts canonical agents the user doesn't have (matched by id).
  // - Refreshes seed-managed entries (those tagged `_seedVersion` or that
  //   look like the prior name-only seed — empty systemPrompt) so existing
  //   users pick up new role prompts, tools, and CLI wiring when the roster
  //   ships an update.
  // - Drops deprecated ids (coder-gemini etc.).
  // Custom entries the operator authored (non-empty prompt, no version tag)
  // are left strictly alone.
  try {
    const seedSnap = await readConfigFileSnapshot();
    if (seedSnap.exists && seedSnap.valid) {
      const beforeList =
        ((seedSnap.config as Record<string, unknown>)?.agents as { list?: unknown[] })?.list ?? [];
      const beforeIds = new Set(
        (Array.isArray(beforeList) ? beforeList : [])
          .map((a) => (a as { id?: string })?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const { seedStandardAgents } = await import("../agents/standard-roster.js");
      let seeded = seedStandardAgents(seedSnap.config as never);
      // Manifest-v2 plugins may contribute roster agents; enabled plugins'
      // agents are seeded, disabled plugins' managed agents are removed.
      const { applyPluginAgentContributions } = await import("../plugins/agent-contributions.js");
      seeded = applyPluginAgentContributions(
        seeded,
        resolveAgentWorkspaceDir(seeded, resolveDefaultAgentId(seeded)),
      );
      const afterList =
        ((seeded as Record<string, unknown>)?.agents as { list?: unknown[] })?.list ?? [];
      const afterIds = new Set(
        (Array.isArray(afterList) ? afterList : [])
          .map((a) => (a as { id?: string })?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const added = [...afterIds].filter((id) => !beforeIds.has(id));
      const dropped = [...beforeIds].filter((id) => !afterIds.has(id));
      // Detect refresh: same id, but the entry changed (cheap heuristic via
      // JSON length so we don't have to deep-diff every field).
      const beforeMap = new Map(
        (Array.isArray(beforeList) ? beforeList : []).map(
          (a) => [(a as { id?: string })?.id ?? "", JSON.stringify(a)] as const,
        ),
      );
      const refreshed: string[] = [];
      for (const entry of Array.isArray(afterList) ? afterList : []) {
        const id = (entry as { id?: string })?.id;
        if (!id || !beforeIds.has(id)) continue;
        const before = beforeMap.get(id);
        if (before && JSON.stringify(entry) !== before) refreshed.push(id);
      }
      const dirty = added.length > 0 || dropped.length > 0 || refreshed.length > 0;
      if (dirty) {
        await writeConfigFile(seeded);
        const parts: string[] = [];
        if (added.length > 0)
          parts.push(
            `+${added.length} new (${added.slice(0, 6).join(", ")}${added.length > 6 ? ", …" : ""})`,
          );
        if (refreshed.length > 0)
          parts.push(
            `${refreshed.length} refreshed (${refreshed.slice(0, 6).join(", ")}${refreshed.length > 6 ? ", …" : ""})`,
          );
        if (dropped.length > 0) parts.push(`-${dropped.length} dropped (${dropped.join(", ")})`);
        log.info(`gateway: agent roster updated: ${parts.join(" · ")}`);
      }
    }
  } catch (err) {
    log.warn(`gateway: failed to seed standard agent roster: ${String(err)}`);
  }

  const cfgAtStart = loadConfig();
  // Apply CLI federation overrides (e.g. --master-mode + --federation-port).
  // These have to land on `cfg.federation` BEFORE the runtime state is
  // initialised, otherwise the master `FederationHub` won't start.
  if (opts.federationOverride) {
    const override = opts.federationOverride;
    // `mode` is required on FederationConfig — pick override → existing → standalone
    // so the merged object is always well-typed.
    const resolvedMode = override.mode ?? cfgAtStart.federation?.mode ?? "standalone";
    cfgAtStart.federation = {
      ...cfgAtStart.federation,
      mode: resolvedMode,
      ...(typeof override.enabled === "boolean" ? { enabled: override.enabled } : {}),
      ...(typeof override.federationPort === "number"
        ? { federationPort: override.federationPort }
        : {}),
      ...(override.masterUrl ? { masterUrl: override.masterUrl } : {}),
      ...(override.masters ? { masters: override.masters } : {}),
      ...(typeof override.masterFailoverTimeoutMs === "number"
        ? { masterFailoverTimeoutMs: override.masterFailoverTimeoutMs }
        : {}),
    };
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: cfgAtStart.commands?.restart === true });
  initSubagentRegistry();
  // Resume watching operator-inbox messages that were in flight across the
  // restart (durable children keep draining their inbox while we are down).
  void import("../agents/subagent-inbox/service.js")
    .then((m) => m.resumeInboxWatching())
    .catch(() => {});
  initializeTerminalManager();
  const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(cfgAtStart, defaultAgentId);
  const baseMethods = listGatewayMethods();
  const { pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayPlugins({
    cfg: cfgAtStart,
    workspaceDir: defaultWorkspaceDir,
    log,
    coreGatewayHandlers,
    baseMethods,
  });
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as Record<ChannelId, RuntimeEnv>;
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
  let pluginServices: PluginServicesHandle | null = null;
  const runtimeConfig = await resolveGatewayRuntimeConfig({
    cfg: cfgAtStart,
    port,
    bind: opts.bind,
    host: opts.host,
    controlUiEnabled: opts.controlUiEnabled,
    openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
    openResponsesEnabled: opts.openResponsesEnabled,
    auth: opts.auth,
    tailscale: opts.tailscale,
  });
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    controlUiBasePath,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  let hooksConfig = runtimeConfig.hooksConfig;
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  const wizardRunner = opts.wizardRunner ?? runOnboardingWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    federationHub,
    clients,
    broadcast: rawBroadcast,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
  } = await createGatewayRuntimeState({
    cfg: cfgAtStart,
    bindHost,
    port,
    controlUiEnabled,
    controlUiBasePath,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    resolvedAuth,
    gatewayTls,
    hooksConfig: () => hooksConfig,
    pluginRegistry,
    deps,
    canvasRuntime,
    canvasHostEnabled,
    allowCanvasHostInTests: opts.allowCanvasHostInTests,
    logCanvas,
    log,
    logHooks,
    logPlugins,
    defaultWorkspaceDir,
  });

  // Wrap the gateway broadcaster so every event ALSO flows through the
  // federation hub's maybeForwardEvent hook. Master uses this to forward
  // agent / terminal streaming events back to satellites that
  // originated a run via master.gateway.invoke — without the wrap,
  // satellite UIs would never see streaming progress for cross-device
  // runs (they'd freeze on "thinking…"). On nodes where federationHub
  // is null (satellites, standalone) the wrap is a pass-through.
  const broadcast: typeof rawBroadcast = federationHub
    ? (event, payload, opts) => {
        try {
          (
            federationHub as unknown as {
              maybeForwardEvent: (e: string, p: unknown) => void;
            }
          ).maybeForwardEvent?.(event, payload);
        } catch (err) {
          log.warn(
            `federation event forward hook failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return rawBroadcast(event, payload, opts);
      }
    : rawBroadcast;

  // Wire up terminal manager events
  setTerminalBroadcaster({ broadcast });

  // Wire up UI control bridge — lets agent tools dispatch into the browser
  // UI's UIControlBus and receive structured responses.
  setUIControlBroadcaster({ broadcaster: { broadcast }, clients });

  // Wire the agentic overlay system's broadcaster so spawn/update/close +
  // highlight effects reach the <agent-overlay-layer> host over `overlay.events`.
  setOverlayBroadcaster(broadcast);

  // Let detach-mode Claude Code subagents emit real-time "agent" tool
  // broadcasts from their stdout NDJSON stream, so the Activity page sees
  // each Read/Edit/Bash without waiting for the 5s sessions.preview poll.
  setSubagentBroadcaster(broadcast);
  setVerificationBroadcaster(broadcast);
  setReviewBroadcaster(broadcast);
  setScreenshotBroadcaster(broadcast);
  // Index existing UI-verification screenshots off the boot path.
  setTimeout(() => {
    try {
      refreshScreenshotIndex({ force: true });
    } catch (err) {
      log.warn(`screenshot index build failed: ${String(err)}`);
    }
  }, 20_000).unref?.();
  // Runs whose attempt died with the previous gateway process (restart /
  // deploy) are re-reviewed from their last RESULT instead of staying FAILED.
  {
    const bootedAt = Date.now();
    const t = setTimeout(() => {
      void (async () => {
        try {
          const { recheckInterruptedRuns, isVerificationEnabled } =
            await import("../verification/pipeline.js");
          if (!isVerificationEnabled()) return;
          const { getSubagentRun, isDurableSubagentRun } =
            await import("../agents/subagent-registry.js");
          await recheckInterruptedRuns({
            bootedAt,
            isRunLive: (runId) => {
              const entry = getSubagentRun(runId);
              return Boolean(entry && entry.endedAt == null && isDurableSubagentRun(entry));
            },
          });
        } catch (err) {
          log.warn(`interrupted-run recheck failed: ${String(err)}`);
        }
      })();
    }, 45_000);
    t.unref?.();
  }
  // Verified completion → kanban: move each run's task (and tasks it
  // referenced) to Done / Review / Blocked from its verdict, and sweep
  // run-linked tasks left In progress after their run ended.
  void import("../verification/kanban-reconcile.js")
    .then(({ installKanbanReconciler }) => {
      if (process.env.INFINIBOT_VERIFIED_COMPLETION !== "0") installKanbanReconciler();
    })
    .catch((err) => log.warn(`kanban reconciler install failed: ${String(err)}`));
  setFederationEventBroadcaster(broadcast);
  setSSHEventBroadcaster(broadcast);
  setClientsBroadcaster(broadcast);
  setCommsBroadcaster(broadcast);

  // Wire the notification emitter so server-side events reach connected mobile clients.
  setNotificationBroadcaster(broadcast);
  // Resolve the Tailscale host once so alert links get a web opener URL early.
  void import("../notifications/public-base.js").then((m) => m.primePublicBase()).catch(() => {});

  // When this gateway is running as a federation master, give the hub a
  // handle to the same broadcaster so it can re-emit events forwarded from
  // satellites (`event.broadcast` messages) to UI clients with a
  // `federationNodeId` tag. Without this, remote PTY output streams would
  // arrive at the master but never reach the browser.
  if (federationHub) {
    (
      federationHub as unknown as {
        setGatewayBroadcaster: (b: {
          broadcast: (event: string, payload: unknown) => void;
        }) => void;
      }
    ).setGatewayBroadcaster?.({ broadcast });
  }

  // Wire up federation event bus to gateway broadcast
  // This allows federation events to be pushed to all connected UI clients
  globalThis.__infinibotUIBroadcast = (message: UIBroadcastMessage) => {
    broadcast("federation.event", message, { dropIfSlow: true });
  };

  let bonjourStop: (() => Promise<void>) | null = null;
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const nodeSubscribe = nodeSubscriptions.subscribe;
  const nodeUnsubscribe = nodeSubscriptions.unsubscribe;
  const nodeUnsubscribeAll = nodeSubscriptions.unsubscribeAll;
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
  applyGatewayLaneConcurrency(cfgAtStart);

  let cronState = buildGatewayCronService({
    cfg: cfgAtStart,
    deps,
    broadcast,
  });
  let { cron, storePath: cronStorePath } = cronState;

  // Calendar alerts — load persisted alerts and rearm timers.
  void initCalendarAlerts().catch((e: unknown) => {
    log.warn(`calendar alerts init failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  // Proactive alert engine — periodic scan for upcoming meetings + project /
  // phase deadlines. Self-guards if Google Calendar / kanban aren't ready.
  try {
    startAlertsRunner();
  } catch (e) {
    log.warn(
      `calendar alerts runner failed to start: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Video analysis: registers the "video" handler with the OCR queue (before
  // the worker drains) and starts the specialist-agent analysis worker.
  try {
    startVideoAnalysis();
  } catch (e) {
    log.warn(`video analysis failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  // GPU runtime manager (vLLM unit / Ollama): swaps on demand, idle-stops vLLM.
  try {
    startLocalRuntimeManager((event, payload) => broadcast(event, payload, { dropIfSlow: true }));
  } catch (err) {
    log.warn(`local runtime manager failed to start: ${String(err)}`);
  }

  // Local auto-OCR worker: durable queue, resumes jobs left by a restart.
  try {
    startOcrWorker((event, payload) => broadcast(event, payload, { dropIfSlow: true }));
  } catch (e) {
    log.warn(`ocr worker failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  const channelManager = createChannelManager({
    loadConfig,
    channelLogs,
    channelRuntimeEnvs,
  });
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;

  const machineDisplayName = await getMachineDisplayName();
  const discovery = await startGatewayDiscovery({
    machineDisplayName,
    port,
    gatewayTls: gatewayTls.enabled
      ? { enabled: true, fingerprintSha256: gatewayTls.fingerprintSha256 }
      : undefined,
    wideAreaDiscoveryEnabled: cfgAtStart.discovery?.wideArea?.enabled === true,
    tailscaleMode,
    mdnsMode: cfgAtStart.discovery?.mdns?.mode,
    logDiscovery,
  });
  bonjourStop = discovery.bonjourStop;

  setSkillsRemoteRegistry(nodeRegistry);
  void primeRemoteSkillsCache();
  // Debounce skills-triggered node probes to avoid feedback loops and rapid-fire invokes.
  // Skills changes can happen in bursts (e.g., file watcher events), and each probe
  // takes time to complete. A 30-second delay ensures we batch changes together.
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  const skillsChangeUnsub = registerSkillsChangeListener((event) => {
    if (event.reason === "remote-node") return;
    if (skillsRefreshTimer) clearTimeout(skillsRefreshTimer);
    skillsRefreshTimer = setTimeout(() => {
      skillsRefreshTimer = null;
      const latest = loadConfig();
      void refreshRemoteBinsForConnectedNodes(latest);
    }, skillsRefreshDelayMs);
  });

  const { tickInterval, healthInterval, dedupeCleanup } = startGatewayMaintenanceTimers({
    broadcast,
    nodeSendToAllSubscribed,
    getPresenceVersion,
    getHealthVersion,
    refreshGatewayHealthSnapshot,
    logHealth,
    dedupe,
    chatAbortControllers,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    removeChatRun,
    agentRunSeq,
    nodeSendToSession,
  });

  const agentUnsub = onAgentEvent(
    createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun,
      clearAgentRunContext,
    }),
  );

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  let heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });

  let agencyOperatingLoop: { stop: () => void } | null = null;
  let projectSummaryLoop: { stop: () => void } | null = null;
  let fh12BuildConductor: { stop: () => void } | null = null;

  let fleetCronStop: (() => void) | null = null;
  let fleetKeepAwakeStop: (() => void) | null = null;
  let fleetIdleStop: (() => void) | null = null;
  void cron
    .start()
    .then(async () => {
      // Hosted fleet tenant Machine: only the tenant's own schedules run. None of
      // the platform's proactive seeds or in-process loops below (they poll, call
      // LLMs and would keep a wake-mode Machine from ever sleeping).
      if (process.env.FLEET_TENANT_ID?.trim()) {
        try {
          const { startFleetKeepAwake } = await import("../saas/fleet-keepawake.js");
          fleetKeepAwakeStop = startFleetKeepAwake(process.env, (m) => logCron.info(m));
          // Activity-based idle sleep (wake-mode plans): an open tab alone no
          // longer keeps the Machine awake (src/saas/fleet-idle.ts).
          const { startFleetIdle } = await import("../saas/fleet-idle.js");
          fleetIdleStop = startFleetIdle(
            {
              broadcast: (event, payload) => broadcast(event, payload, { dropIfSlow: true }),
              closeClients: (code, reason) => {
                let n = 0;
                for (const c of Array.from(clients)) {
                  try {
                    c.socket.close(code, reason);
                    n++;
                  } catch {
                    // already closing
                  }
                }
                return n;
              },
            },
            process.env,
            (m) => logCron.info(`fleet: ${m}`),
          );
          const { startFleetCron, fleetCronEvent } = await import("../cron/fleet-hosted.js");
          const { addCronEventTap } = await import("./server-cron.js");
          const stopFleetCron = await startFleetCron(cron, {
            info: (m) => logCron.info(m),
            warn: (m) => logCron.warn(m),
          });
          const untap = addCronEventTap(fleetCronEvent);
          fleetCronStop = () => {
            untap();
            stopFleetCron?.();
          };
        } catch (err) {
          logCron.warn(`fleet cron wiring failed: ${String(err)}`);
        }
        return;
      }
      // Seed the default proactive cron jobs (idempotent — matched by name, so
      // existing jobs and operator edits are left untouched). Non-fatal.
      try {
        const { ensureDefaultProactiveCronJobs } = await import("../cron/default-jobs.js");
        const created = await ensureDefaultProactiveCronJobs(cron);
        if (created.length > 0) {
          logCron.info(`seeded default proactive cron jobs: ${created.join(", ")}`);
        }
        // Business & Agency plugin jobs (CEO hourly report, agency operating
        // loop) are seeded/started only while that plugin is loaded; see
        // src/business-agency/cron.ts. Toggling the plugin reloads the gateway.
        const { isBusinessAgencyActive } = await import("../business-agency/runtime.js");
        const businessAgencyOn = isBusinessAgencyActive();
        // Report system: hourly CEO insights cron (:05). Idempotent, matched by name.
        const { ensureCeoReportCronJobs, CEO_HOURLY_CRON_NAME } =
          await import("../reports/ceo-cron.js");
        if (businessAgencyOn && (await ensureCeoReportCronJobs(cron))) {
          logCron.info(`seeded report cron job: ${CEO_HOURLY_CRON_NAME}`);
        }
        // Proactive report cron jobs (daily brief, content overview, dev summary).
        const { ensureProactiveReportCronJobs } = await import("../reports/proactive-cron.js");
        const proactiveReportCreated = await ensureProactiveReportCronJobs(cron);
        if (proactiveReportCreated > 0) {
          logCron.info(`seeded ${proactiveReportCreated} proactive report cron jobs`);
        }
        // Proactive Oversight: default daily/weekly/monthly/continuous cron jobs
        // + on-event report rules. Idempotent, matched by name/eventType.
        const { ensureOversightCronJobs, ensureOversightEventTriggers } =
          await import("../cron/oversight-jobs.js");
        const oversightCreated = await ensureOversightCronJobs(cron);
        if (oversightCreated.length > 0) {
          logCron.info(`seeded oversight cron jobs: ${oversightCreated.join(", ")}`);
        }
        const oversightTriggers = await ensureOversightEventTriggers();
        if (oversightTriggers.length > 0) {
          logCron.info(`seeded oversight event rules: ${oversightTriggers.join(", ")}`);
        }
        // Agency workforce operating loop: seed the operator-visible cron job
        // (idempotent, matched by name) and start the in-process scheduler that
        // actually ticks every agency. Cron payloads can only nudge an agent
        // session, so the database work runs here; the cron job owns the cadence
        // and the enabled flag so Settings edits control the real loop.
        const {
          ensureAgencyOperatingLoopCronJobs,
          findAgencyOperatingLoopJob,
          operatingLoopIntervalFromJob,
          AGENCY_OPERATING_LOOP_JOB_NAME,
        } = await import("../cron/agency-operating-jobs.js");
        const configuredLoopMs = cfgAtStart?.cron?.agencyOperatingLoopMs;
        const loopCreated = businessAgencyOn
          ? await ensureAgencyOperatingLoopCronJobs(cron, { everyMs: configuredLoopMs })
          : [];
        if (loopCreated.length > 0) {
          logCron.info(`seeded agency cron job: ${AGENCY_OPERATING_LOOP_JOB_NAME}`);
        }
        const { createAgencyOperatingLoopDeps, startAgencyOperatingLoopScheduler } =
          await import("../agency-operations/operating-loop.js");
        const { resolveStateDir } = await import("../config/paths.js");
        const loopJob = await findAgencyOperatingLoopJob(cron);
        agencyOperatingLoop = !businessAgencyOn
          ? null
          : startAgencyOperatingLoopScheduler({
              // SAFETY: work-item execution (which spawns real coder CLIs and can
              // cost money) only turns on when `cron.agencyOperatingLoop
              // .executeWorkItems` is explicitly true. Default: off.
              deps: createAgencyOperatingLoopDeps(
                resolveStateDir(),
                {
                  info: (msg) => logCron.info(msg),
                  warn: (msg) => logCron.warn(msg),
                  error: (msg) => logCron.error(msg),
                },
                {
                  execution: cfgAtStart?.cron?.agencyOperatingLoop ?? null,
                  workspaceRoot: resolveStateDir(),
                  broadcast: (event, payload) => broadcast(event, payload, { dropIfSlow: true }),
                  // Threading the cron service in lets first-run provisioning
                  // create REAL, operator-visible SOP schedules in Settings rather
                  // than rows only the loop can see.
                  cron,
                },
              ),
              intervalMs: operatingLoopIntervalFromJob(loopJob, configuredLoopMs),
              isEnabled: async () => (await findAgencyOperatingLoopJob(cron))?.enabled !== false,
            });
        // Daily AI project current-state summaries: seed the operator-visible
        // cron job (idempotent, matched by name) and start the in-process
        // scheduler that actually regenerates summaries for in-progress
        // projects. Same split as the agency loop — the cron job owns the
        // cadence/enabled flag; the real LLM+DB work runs here.
        const {
          ensureProjectSummaryCronJobs,
          normalizeProjectSummaryIntervalMs,
          PROJECT_SUMMARY_JOB_NAME,
        } = await import("../cron/project-summary-jobs.js");
        const summaryCreated = await ensureProjectSummaryCronJobs(cron);
        if (summaryCreated.length > 0) {
          logCron.info(`seeded project summary cron job: ${PROJECT_SUMMARY_JOB_NAME}`);
        }
        const findProjectSummaryJob = async () =>
          (await cron.list({ includeDisabled: true })).find(
            (j) => j.name === PROJECT_SUMMARY_JOB_NAME,
          );
        const summaryJob = await findProjectSummaryJob();
        const summaryIntervalMs =
          summaryJob?.schedule.kind === "every"
            ? normalizeProjectSummaryIntervalMs(summaryJob.schedule.everyMs)
            : normalizeProjectSummaryIntervalMs(undefined);
        const { startProjectSummaryScheduler } = await import("../project-summary/scheduler.js");
        projectSummaryLoop = startProjectSummaryScheduler({
          intervalMs: summaryIntervalMs,
          isEnabled: async () => (await findProjectSummaryJob())?.enabled !== false,
        });

        // Optional build conductor: a fully-isolated, milestone-gated in-process
        // build loop on its OWN interval (never blocks/changes the agency tick
        // above). SAFETY: gated behind `conductor.fh12.enabled` in infinibot.json
        // OR env `INFINIBOT_FH12_CONDUCTOR=1`. `isEnabled` is re-read every pass,
        // so with the flag off the scheduler wires no deps and does nothing —
        // not even reading build-state.json. Default: dead.
        const { startBuildConductorScheduler } = await import("../agency/build-conductor.js");
        const fh12EnvEnabled =
          process.env.INFINIBOT_FH12_CONDUCTOR === "1" ||
          process.env.INFINIBOT_FH12_CONDUCTOR === "true";
        const fh12ConfEnabled = () => loadConfig()?.conductor?.fh12?.enabled === true;
        const conductorProjectDir =
          process.env.INFINIBOT_BUILD_CONDUCTOR_PROJECT_DIR?.trim() ||
          cfgAtStart?.conductor?.fh12?.projectDir?.trim();
        if (conductorProjectDir) {
          fh12BuildConductor = startBuildConductorScheduler({
            projectDir: conductorProjectDir,
            intervalMs: cfgAtStart?.conductor?.fh12?.intervalMs ?? 600_000,
            // Re-read every pass so toggling the flag pauses/resumes without a
            // restart. Off by default: neither source is truthy unless set.
            isEnabled: () => fh12EnvEnabled || fh12ConfEnabled(),
            log: {
              info: (msg) => logCron.info(`[build-conductor] ${msg}`),
              warn: (msg) => logCron.warn(`[build-conductor] ${msg}`),
              error: (msg) => logCron.error(`[build-conductor] ${msg}`),
            },
          });
        } else if (fh12EnvEnabled || fh12ConfEnabled()) {
          logCron.warn(
            "build conductor enabled without a project directory; set conductor.fh12.projectDir or INFINIBOT_BUILD_CONDUCTOR_PROJECT_DIR",
          );
        }
      } catch (err) {
        logCron.warn(`failed to seed default proactive cron jobs: ${String(err)}`);
      }
    })
    .catch((err) => logCron.error(`failed to start: ${String(err)}`));

  // Unified approval registry: restore persisted requests (expired /
  // non-resumable ones are closed as denied), fan every request/resolution out
  // to WS clients (web approvals inbox) and to the operator's Telegram.
  try {
    const { loadApprovalRegistry, onApprovalEvent } =
      await import("../autonomy/approval-registry.js");
    const { installTelegramApprovals } = await import("../approvals/telegram-approvals.js");
    installTelegramApprovals();
    // Phone push for each new request, deep-linked to infinibot://approvals/<id>.
    const { installApprovalPush } = await import("../approvals/push-approvals.js");
    installApprovalPush();
    onApprovalEvent((e) => {
      broadcast(`approval.${e.type}`, { record: e.record }, { dropIfSlow: true });
    });
    loadApprovalRegistry();
  } catch (err) {
    log.warn(`approvals: failed to initialise unified registry: ${String(err)}`);
  }

  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
  });

  const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

  attachGatewayWsHandlers({
    wss,
    clients,
    port,
    gatewayHost: bindHost ?? undefined,
    canvasHostEnabled: Boolean(canvasHost),
    canvasHostServerPort,
    resolvedAuth,
    gatewayMethods,
    events: GATEWAY_EVENTS,
    logGateway: log,
    logHealth,
    logWsControl,
    extraHandlers: {
      ...pluginRegistry.gatewayHandlers,
      ...execApprovalHandlers,
    },
    broadcast,
    context: {
      deps,
      cron,
      cronStorePath,
      loadGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshot,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
      broadcast,
      nodeSendToSession,
      nodeSendToAllSubscribed,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      hasConnectedMobileNode: hasMobileNodeConnected,
      nodeRegistry,
      agentRunSeq,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      addChatRun,
      removeChatRun,
      dedupe,
      wizardSessions,
      findRunningWizard,
      purgeWizardSession,
      getRuntimeSnapshot,
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      broadcastVoiceWakeChanged,
    },
  });
  logGatewayStartup({
    cfg: cfgAtStart,
    bindHost,
    bindHosts: httpBindHosts,
    port,
    tlsEnabled: gatewayTls.enabled,
    log,
    isNixMode,
  });
  scheduleGatewayUpdateCheck({ cfg: cfgAtStart, log, isNixMode });
  // Bring `tailscale serve` up so the tailnet URL works after a reboot with no
  // manual step. Detached on purpose: the listener is already up, and the
  // tailscale CLI must never delay or fail gateway startup. Off by default —
  // see resolveTailscaleExposurePlan(). Also covers the Expo Metro dev server
  // so the mobile app connects without scanning a LAN QR every time.
  const tailscaleCleanup = startGatewayTailscaleExposureDetached({
    plan: resolveTailscaleExposurePlan({
      cfg: { ...tailscaleConfig, mode: tailscaleMode },
      gatewayPort: port,
    }),
    controlUiBasePath,
    logTailscale,
  });

  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  let claudeCodeWatcher: Awaited<ReturnType<typeof startGatewaySidecars>>["claudeCodeWatcher"] =
    null;
  ({ browserControl, pluginServices, claudeCodeWatcher } = await startGatewaySidecars({
    cfg: cfgAtStart,
    resolvedAuth,
    pluginRegistry,
    defaultWorkspaceDir,
    deps,
    startChannels,
    log,
    logHooks,
    logChannels,
    logBrowser,
  }));

  const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
    deps,
    broadcast,
    getState: () => ({
      hooksConfig,
      heartbeatRunner,
      cronState,
      browserControl,
    }),
    setState: (nextState) => {
      hooksConfig = nextState.hooksConfig;
      heartbeatRunner = nextState.heartbeatRunner;
      cronState = nextState.cronState;
      cron = cronState.cron;
      cronStorePath = cronState.storePath;
      browserControl = nextState.browserControl;
    },
    startChannel,
    stopChannel,
    logHooks,
    logBrowser,
    logChannels,
    logCron,
    logReload,
  });

  const configReloader = startGatewayConfigReloader({
    initialConfig: cfgAtStart,
    readSnapshot: readConfigFileSnapshot,
    onHotReload: applyHotReload,
    onRestart: requestGatewayRestart,
    log: {
      info: (msg) => logReload.info(msg),
      warn: (msg) => logReload.warn(msg),
      error: (msg) => logReload.error(msg),
    },
    watchPath: CONFIG_PATH,
  });

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    stopChannel,
    pluginServices,
    cron,
    heartbeatRunner,
    nodePresenceTimers,
    broadcast,
    tickInterval,
    healthInterval,
    dedupeCleanup,
    agentUnsub,
    heartbeatUnsub,
    chatRunState,
    clients,
    configReloader,
    browserControl,
    claudeCodeWatcher,
    federationHub,
    wss,
    httpServer,
    httpServers,
  });

  return {
    bindHost,
    bindHosts: httpBindHosts,
    port,
    controlUiBasePath,
    close: async (opts) => {
      if (diagnosticsEnabled) {
        stopDiagnosticHeartbeat();
      }
      if (skillsRefreshTimer) {
        clearTimeout(skillsRefreshTimer);
        skillsRefreshTimer = null;
      }
      skillsChangeUnsub();
      agencyOperatingLoop?.stop();
      agencyOperatingLoop = null;
      projectSummaryLoop?.stop();
      projectSummaryLoop = null;
      fleetCronStop?.();
      fleetCronStop = null;
      fleetKeepAwakeStop?.();
      fleetKeepAwakeStop = null;
      fleetIdleStop?.();
      fleetIdleStop = null;
      fh12BuildConductor?.stop();
      fh12BuildConductor = null;
      // Clean up federation event bus broadcast
      globalThis.__infinibotUIBroadcast = undefined;
      await close(opts);
    },
  };
}

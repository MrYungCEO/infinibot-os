import { applyShareToCapabilities } from "../federation/share-policy.js";
import { satelliteTokenFromConfig } from "../federation/security.js";
import type { Server as HttpServer } from "node:http";
import { setSecureModeBroadcaster } from "../secure-mode/events.js";
import { getResearchApprovals } from "../secure-mode/research/approvals.js";
import { getSecureModeRuntime } from "../secure-mode/runtime.js";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { HooksConfigResolved } from "./hooks.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { resolveGatewayListenHosts } from "./net.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { type ChatRunEntry, createChatRunState } from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import { initFederationHub, type FederationHub } from "../federation/hub.js";
import { setFederationEventBroadcaster } from "../federation/events.js";
import {
  FederationSatellite,
  getFederationSatellite,
  type SatelliteConfig,
} from "../federation/satellite.js";
import { attachGatewayProxyRequestListener } from "../federation/satellite-proxy-listener.js";
import { startReportsWorker } from "./reports-worker-bootstrap.js";
import { startPlanRefreshLoop } from "../credits/plan-refresh.js";
import { setSSHEventBroadcaster } from "../ssh-devices/events.js";
import { setKanbanEventBroadcaster } from "../tasks/kanban-events.js";
import { setRepoHealthBroadcaster } from "../projects/repos/service.js";
import { setNotesEventBroadcaster } from "../notes/notes-events.js";
import { setIdeasEventBroadcaster } from "../ideas/events.js";
import { setPrioritiesEventBroadcaster } from "../priorities/priorities-events.js";
import { setQueueEventBroadcaster } from "../queue/events.js";
import { startQueueOrchestrator } from "../queue/boot.js";
import { startGoalRunner } from "../autonomy/goals/service.js";
import { startScheduledTasks } from "../autonomy/scheduled-tasks/runtime.js";
import {
  ensureOllamaRunning,
  getLastOllamaStatus,
  startOllamaHealthPing,
} from "../ollama/ensure-ollama.js";
import { ensureKokoroRunning, startKokoroHealthPing } from "./kokoro-bootstrap.js";
import { bootstrapVoiceRuntime } from "./voice/bootstrap.js";
import { localProvidersEnabled } from "../saas/config.js";

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").InfinibotConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  /** Workspace directory for identity sync (SOUL.md, etc.) */
  defaultWorkspaceDir?: string;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  federationHub: FederationHub | null;
  clients: Set<GatewayWsClient>;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}> {
  // Local providers (Ollama, native/Docker voice) are disabled in cloud-only /
  // SaaS mode — see localProvidersEnabled(). Cloud LLM + cloud voice paths are
  // unaffected by this flag.
  const allowLocalProviders = localProvidersEnabled();

  // Bootstrap local Ollama: autostart `ollama serve` if needed, health-check
  // `/api/tags` with retries+backoff, and keep the status fresh. This makes the
  // node's Ollama discoverable (federation manifest), drives the default-provider
  // fallback, and powers GET /api/ollama/health. Fire-and-forget — never block
  // gateway boot on it.
  if (allowLocalProviders)
    void ensureOllamaRunning({ cfg: params.cfg })
      .then((status) =>
        params.log.info(
          status.running
            ? `[OLLAMA] available at ${status.host} (${status.models.length} models)${status.startedByUs ? " — started by gateway" : ""}`
            : `[OLLAMA] not available at ${status.host}`,
        ),
      )
      .catch((err) => params.log.warn(`[OLLAMA] bootstrap failed: ${String(err)}`));

  // Periodic health ping — refreshes cached status and, on a satellite,
  // re-advertises live Ollama capabilities to the federation master.
  if (allowLocalProviders)
    startOllamaHealthPing({
      cfg: params.cfg,
      onChange: (status) => {
        try {
          const sat = getFederationSatellite();
          if (sat) {
            sat.updateCapabilities({
              hasOllama: status.running,
              ollamaModels: status.running ? status.models : [],
            });
          }
        } catch {
          // best-effort capability refresh
        }
      },
    });

  // Bootstrap local Kokoro TTS: when the user has selected Kokoro as their TTS
  // provider (voice-settings.json `tts_provider: kokoro`), autostart the
  // `infinibot-kokoro` container via `docker compose -f docker-compose.voice.yaml
  // up -d kokoro` and health-check it. Docker is a soft dependency — a missing
  // CLI just logs a warning. No-op for elevenlabs/edge/openai users. Powers
  // GET /api/kokoro/health. Fire-and-forget — never block gateway boot on it.
  // Kokoro is a *local* Docker TTS — skipped in cloud-only mode (cloud TTS
  // providers like ElevenLabs/OpenAI/edge remain fully available).
  if (allowLocalProviders)
    void ensureKokoroRunning()
      .then((status) =>
        params.log.info(
          !status.selected
            ? `[KOKORO] not selected as TTS provider — skipped`
            : status.ready
              ? `[KOKORO] ready at ${status.url}${status.startedByUs ? " — started by gateway" : ""}`
              : `[KOKORO] not available at ${status.url}`,
        ),
      )
      .catch((err) => params.log.warn(`[KOKORO] bootstrap failed: ${String(err)}`));

  // Periodic health ping — refreshes the cached `kokoroReady` flag and
  // relaunches Kokoro if it stops while still selected.
  if (allowLocalProviders) startKokoroHealthPing();

  // Voice runtime bootstrap — read voice.json and bring up the saved stack:
  // docker mode → idempotent `docker compose up -d`; native mode → verify the
  // whisper.cpp binary/model are installed (warn if not) + pre-warm kokoro-js.
  // Fire-and-forget so a voice misconfig never blocks gateway boot.
  void bootstrapVoiceRuntime({
    info: (m) => params.log.info(m),
    warn: (m) => params.log.warn(m),
  }).catch((err) => params.log.warn(`[VOICE] bootstrap failed: ${String(err)}`));

  // Bootstrap the report render worker as a separate, supervised child process.
  // The worker renders queued reports (HTML→PDF via puppeteer); running it out
  // of process means a Chrome/puppeteer crash can never destabilize the
  // gateway. Fire-and-forget — a missing build just logs a warning.
  try {
    startReportsWorker({
      info: (m) => params.log.info(m),
      warn: (m) => params.log.warn(m),
    });
  } catch (err) {
    params.log.warn(`[REPORTS-WORKER] bootstrap failed: ${String(err)}`);
  }

  // Background plan-usage refresh — pulls each configured provider's plan/quota
  // usage (Anthropic/OpenAI Admin API where available, local estimate otherwise)
  // into the provider_plan_usage cache every ~5 min. In-process + fully isolated
  // per-provider, so a failing/slow puller can never destabilize the gateway.
  try {
    // Operator plan-usage pollers (provider admin APIs): never on a hosted
    // tenant Machine — it isn't the operator's, and the poll keeps it busy.
    if (!process.env.FLEET_TENANT_ID?.trim()) startPlanRefreshLoop();
  } catch (err) {
    params.log.warn(`[CREDITS] plan refresh loop failed to start: ${String(err)}`);
  }

  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  const httpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  for (const host of bindHosts) {
    const httpServer = createGatewayHttpServer({
      canvasHost,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      handleHooksRequest,
      handlePluginRequest,
      resolvedAuth: params.resolvedAuth,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
    });
    try {
      await listenGatewayHttpServer({
        httpServer,
        bindHost: host,
        port: params.port,
      });
      httpServers.push(httpServer);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) throw err;
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  // Initialize FederationHub if running in master mode
  let federationHub: FederationHub | null = null;
  // `enabled` is redundant with `mode` (mode==="standalone" already means off).
  // Treat enabled as true unless explicitly set to false, so configs that only
  // set `mode: "master"` (e.g. older configs, wizard, manual edits) still start the hub.
  const fedEnabled = params.cfg.federation?.enabled !== false;
  const fedMode = params.cfg.federation?.mode;
  const federationMasterMode = fedEnabled && fedMode === "master";

  const debugLog = (msg: string) => {
    params.log.info(`[FEDERATION] ${msg}`);
  };
  debugLog(
    `cfg.federation.enabled=${fedEnabled}, cfg.federation.mode=${fedMode}, masterMode=${federationMasterMode}`,
  );
  params.log.info(
    `[FEDERATION] enabled=${fedEnabled}, mode=${fedMode}, masterMode=${federationMasterMode}`,
  );

  if (federationMasterMode) {
    debugLog("Initializing hub...");
    federationHub = initFederationHub({
      httpServer: httpServer, // Attach to main HTTP server
      // Attached hubs serve on the gateway port; mDNS advertises this.
      port: params.port,
      wsPath: "/federation",
      workspace: params.defaultWorkspaceDir ?? process.cwd(),
      syncGatewayPassword: true,
      gatewayPassword: params.resolvedAuth.token ?? params.resolvedAuth.password ?? "",
    });
    debugLog("Hub initialized, starting...");
    // Start the hub FIRST - it will attach its own /federation upgrade handler
    // Must await to ensure the handler is attached before gateway handlers
    try {
      await federationHub.start();
      debugLog("Hub started successfully!");
      params.log.info("federation hub started (master mode)");
    } catch (err) {
      debugLog(`Hub start failed: ${String(err)}`);
      params.log.warn(`federation hub failed to start: ${String(err)}`);
      federationHub = null;
    }
  } else {
    debugLog("Not starting hub - masterMode is false");
  }

  // Initialize FederationSatellite if running in satellite mode
  const federationSatelliteMode =
    fedEnabled && fedMode === "satellite" && params.cfg.federation?.masterUrl;
  let federationSatellite: FederationSatellite | null = null;

  // Skip duplicate satellite init when the CLI satellite-mode path
  // (`infinibot gateway` → runSatelliteMode → startGatewayServer) already
  // constructed one. Without this guard, two FederationSatellite instances
  // race to register with the same master — the CLI path normalizes the
  // URL with `/federation` but historically this one didn't, so the
  // runtime-state instance would hit the gateway WSS and die in a
  // reconnect loop (`connect.challenge` "Invalid federation message
  // structure"). Detection works because runSatelliteMode registers its
  // satellite as the singleton via `setFederationSatellite`.
  const skipRuntimeSatellite = federationSatelliteMode && getFederationSatellite() != null;
  if (skipRuntimeSatellite) {
    params.log.info(
      "[FEDERATION] satellite already initialised by CLI, skipping runtime-state init",
    );
    debugLog("Skipping satellite init - singleton already set");
  }

  if (federationSatelliteMode && !skipRuntimeSatellite) {
    const rawMasterUrl = params.cfg.federation!.masterUrl!;
    const normalizeMasterUrl = (value: string): string => {
      let masterUrl = value;
      if (masterUrl.startsWith("http://")) {
        masterUrl = `ws://${masterUrl.slice("http://".length)}`;
      } else if (masterUrl.startsWith("https://")) {
        masterUrl = `wss://${masterUrl.slice("https://".length)}`;
      } else if (
        !masterUrl.startsWith("ws://") &&
        !masterUrl.startsWith("wss://") &&
        masterUrl !== "auto"
      ) {
        masterUrl = `ws://${masterUrl}`;
      }
      if (masterUrl === "auto") return masterUrl;
      try {
        const url = new URL(masterUrl);
        if (!url.pathname || url.pathname === "/") {
          url.pathname = "/federation";
        }
        return url.toString();
      } catch {
        return value;
      }
    };
    // Normalize the URL so a bare `ws://host:port` (or `host:port`)
    // connects to the federation hub instead of the gateway WSS. Mirrors
    // runSatelliteMode's formatMasterUrl behaviour so both code paths
    // produce the same final URL.
    const masterUrl = normalizeMasterUrl(rawMasterUrl);
    const masters = [
      masterUrl,
      ...(params.cfg.federation?.masters ?? []).map((url) => normalizeMasterUrl(url)),
    ].filter((url, index, all) => url && all.indexOf(url) === index);
    const nodeName = params.cfg.federation?.nodeName ?? (await import("node:os")).hostname();

    debugLog(`Initializing satellite, connecting to ${masterUrl}...`);
    params.log.info(`[FEDERATION] satellite mode, connecting to ${masterUrl}`);

    const satelliteConfig: SatelliteConfig = {
      masterUrl,
      masters,
      masterFailoverTimeoutMs: params.cfg.federation?.masterFailoverTimeoutMs,
      nodeName,
      workspace: params.defaultWorkspaceDir ?? process.cwd(),
      capabilities: applyShareToCapabilities(params.cfg.federation?.share, {
        hasOllama:
          getLastOllamaStatus()?.running ?? params.cfg.federation?.capabilities?.hasOllama ?? false,
        ollamaModels: getLastOllamaStatus()?.running ? getLastOllamaStatus()?.models : undefined,
        hasComfyUI: params.cfg.federation?.capabilities?.hasComfyUI ?? false,
        hasVoice: params.cfg.federation?.capabilities?.hasVoice ?? false,
        mcpServers: [],
        agents: params.cfg.agents ? Object.keys(params.cfg.agents) : ["defaults"],
        workspaces: [params.defaultWorkspaceDir ?? process.cwd()],
        platform: process.platform,
        arch: process.arch,
      }),
      // The signed token from the invite (`federation join` / the setup
      // wizard). Without it a restarted satellite registers tokenless and a
      // default master (requireRegisterToken unset) rejects it.
      authToken: satelliteTokenFromConfig(params.cfg.federation?.authToken),
      share: params.cfg.federation?.share,
      autoReconnect: true,
      autoDiscover: params.cfg.federation?.discovery ?? false,
      discoveryTimeoutMs: 10000,
    };

    federationSatellite = new FederationSatellite(satelliteConfig);

    // Set up satellite event handlers
    federationSatellite.on("connected", (nodeId) => {
      params.log.info(`[FEDERATION] connected to master as ${nodeId}`);
    });

    federationSatellite.on("disconnected", (reason) => {
      params.log.warn(`[FEDERATION] disconnected from master: ${reason}`);
    });

    federationSatellite.on("error", (err) => {
      params.log.warn(`[FEDERATION] satellite error: ${err.message}`);
    });

    // Handle session spawn requests from master.
    // Route through sessions.spawn (not agent directly) so the satellite's
    // agent config is respected — terminal-mode agents (claude_coder,
    // opencode, codex) get their CLI spawned via terminal.spawnAgent while
    // plain agents fall through to the agent-loop path. Previously this
    // called `agent` directly, which bypassed the execution-mode check and
    // left CLI agents running as generic loop agents on the satellite.
    federationSatellite.on("session:spawn:request", async (request: Record<string, unknown>) => {
      const correlationId = request.correlationId as string | undefined;
      const agentId = (request.agentId as string) || "coder";
      const task = (request.task as string) || "";
      const label = (request.label as string) || `remote-${agentId}-${Date.now()}`;

      debugLog(
        `[SPAWN] Received: correlationId=${correlationId}, agentId=${agentId}, label=${label}`,
      );

      try {
        const { callGateway } = await import("./call.js");

        // Use sessions.spawn so the satellite honours its own agent config
        // (execution.mode === "terminal" → CLI tool, else agent-loop).
        const response = (await callGateway({
          method: "sessions.spawn",
          params: {
            task,
            agentId,
            label,
            thinking: request.thinking as string | undefined,
            runTimeoutSeconds: request.timeout as number | undefined,
          },
          timeoutMs: 30_000,
        })) as { runId?: string; childSessionKey?: string; sessionKey?: string; status?: string };

        const sessionKey = response?.childSessionKey || response?.sessionKey;
        const actualRunId = response?.runId;

        if (!sessionKey || !actualRunId) {
          // sessions.spawn returned but without the keys we need — this should
          // not normally happen; surface it rather than fabricating a phantom key.
          const detailMsg = `sessions.spawn returned status=${response?.status ?? "unknown"} without childSessionKey/runId`;
          debugLog(`[SPAWN] Error: ${detailMsg}`);
          if (correlationId) {
            federationSatellite!.sendSessionResult("session.spawn.result", correlationId, {
              success: false,
              error: detailMsg,
            });
          }
          return;
        }

        debugLog(`[SPAWN] Local agent spawned: sessionKey=${sessionKey}, runId=${actualRunId}`);

        // Send success result back to master
        federationSatellite!.sendSessionResult(
          "session.spawn.result",
          correlationId || actualRunId,
          {
            success: true,
            sessionKey,
            runId: actualRunId,
          },
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        debugLog(`[SPAWN] Failed: ${error}, correlationId=${correlationId}`);

        if (correlationId) {
          federationSatellite!.sendSessionResult("session.spawn.result", correlationId, {
            success: false,
            error,
          });
        }
      }
    });

    // Handle session send requests from master
    federationSatellite.on("session:send:request", async (request: Record<string, unknown>) => {
      const correlationId = request.correlationId as string | undefined;
      const sessionKey = request.sessionKey as string;
      const message = request.message as string;

      try {
        const { callGateway } = await import("./call.js");

        // chat.send is the gateway's "send a message into a session" method.
        // It returns immediately with { runId, status: "started" } and runs
        // the agent asynchronously — federation only needs the dispatch ack,
        // not the assistant's reply, so we don't await completion here.
        // idempotencyKey is required; correlationId (= master's messageId) is
        // already unique per message and gives natural retry-safety.
        const idempotencyKey =
          correlationId ??
          `federation-${sessionKey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await callGateway({
          method: "chat.send",
          params: { sessionKey, message, idempotencyKey },
          timeoutMs: 30_000,
        });

        if (correlationId) {
          federationSatellite!.sendSessionResult("session.send.result", correlationId, {
            success: true,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        debugLog(
          `[SEND] Failed: ${error}, correlationId=${correlationId}, sessionKey=${sessionKey}`,
        );

        if (correlationId) {
          federationSatellite!.sendSessionResult("session.send.result", correlationId, {
            success: false,
            error,
          });
        }
      }
    });

    // gateway:proxy:request listener is wired below against the resolved
    // satellite (local OR CLI-installed singleton) so it works in BOTH
    // satellite-startup paths.

    // Connect to master (non-blocking)
    federationSatellite
      .connect()
      .then(() => {
        debugLog("Satellite connected successfully!");
        params.log.info("[FEDERATION] satellite connected to master");
      })
      .catch((err) => {
        debugLog(`Satellite connect failed: ${String(err)}`);
        params.log.warn(`[FEDERATION] satellite failed to connect: ${err.message}`);
      });
  }

  for (const server of httpServers) {
    // Skip /federation in gateway upgrade handler if federation master mode is active
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      canvasHost,
      skipFederationPath: federationMasterMode,
      workspaceAuth: {
        auth: params.resolvedAuth,
        trustedProxies: params.cfg.gateway?.trustedProxies ?? [],
        port: params.port,
      },
    });
  }

  const clients = new Set<GatewayWsClient>();
  const { broadcast: rawBroadcast } = createGatewayBroadcaster({ clients });

  // Resolve the satellite this gateway should bind to: prefer the one we
  // just created locally, otherwise fall back to the CLI-installed
  // singleton (runSatelliteMode sets it before startGatewayServer). Using
  // the LOCAL var alone misses the CLI case — that's exactly the silent
  // hole that left cross-node `terminal.create` from mobile blank: the
  // event tee below and the `gateway:proxy:request` listener below were
  // both gated on the local var and so were no-ops in CLI satellite mode.
  const attachedSatellite =
    federationSatellite ??
    (typeof getFederationSatellite === "function" ? getFederationSatellite() : null);

  // When running in satellite mode, tee broadcasts that the master UI needs
  // to render remote sessions up the federation pipe. Terminals stream PTY
  // output; chat/agent stream the assistant's reply tokens so a remote chat
  // panel sees the same words appear that the satellite's local UI would.
  // Other broadcasts (presence/health/etc.) stay local — they'd only add
  // noise on the federation socket.
  const broadcast: typeof rawBroadcast = attachedSatellite
    ? (event, payload, opts) => {
        rawBroadcast(event, payload, opts);
        if (
          event === "terminal.output" ||
          event === "terminal.created" ||
          event === "terminal.destroyed" ||
          event === "terminal.exit" ||
          // Title-rename event from agent-cli-integration-handler — the
          // emitter uses "terminal.titleChange", not "terminal.title", so
          // master-side panel titles stayed stale until this filter matched.
          event === "terminal.titleChange" ||
          // Chat / agent streaming — needed so the master's chat panel
          // pointing at this satellite shows the live reply tokens. The
          // events arrive at the master tagged with `federationNodeId`
          // and the existing UI handlers route by sessionKey, so chat
          // content lands in the right panel without further plumbing.
          event === "chat" ||
          event === "agent"
        ) {
          // Don't await — broadcast must stay non-blocking for local clients.
          void attachedSatellite.sendEventToMaster(event, payload).catch(() => undefined);
        }
      }
    : rawBroadcast;

  setFederationEventBroadcaster(broadcast);
  setSSHEventBroadcaster(broadcast);
  // Kanban + notes live-update bridge: agent/MCP writes and RPC writes both
  // call broadcastKanbanChanged / broadcastNotesChanged, which fan out here to
  // every open UI tab (see src/tasks/kanban-events.ts, src/notes/notes-events.ts).
  setKanbanEventBroadcaster(broadcast);
  // Repo health / deploy-branch events (background scans, daily report).
  setRepoHealthBroadcaster(broadcast);
  // Warm the Notion-backed board lists off the boot path (see kanban-list-cache.ts).
  setTimeout(() => {
    void import("./server-methods/kanban.js")
      .then((m) => m.prewarmKanbanListCache())
      .catch(() => undefined);
  }, 10_000).unref?.();
  setNotesEventBroadcaster(broadcast);
  setIdeasEventBroadcaster(broadcast);
  // Secure Mode: restore the persisted on/off state (unlocks from the OS
  // keyring when it was on) and broadcast it so open UIs pick it up.
  setSecureModeBroadcaster(broadcast);
  // Ids + status only; the card fetches the queries over secure.research.pending.
  getResearchApprovals().setBroadcaster((event, payload) =>
    broadcast(event, payload, { dropIfSlow: true }),
  );
  void getSecureModeRuntime()
    .init()
    .then((status) => broadcast("secure.mode.changed", status))
    .catch(() => undefined);
  // Documents import jobs (Notion API / export ZIP) interrupted by the last
  // shutdown resume in the background — the importers are idempotent.
  setTimeout(() => {
    void import("../documents/import-jobs.js")
      .then((m) => m.resumeImportJobs())
      .catch(() => undefined);
  }, 5_000).unref?.();
  setPrioritiesEventBroadcaster(broadcast);
  // Persistent queue + phase orchestrator (see src/queue/*). The broadcaster
  // bridge lets queue.enqueued / phase_started / done events reach the
  // activity feed + iso-map holding zone. The orchestrator itself is a
  // gateway-side singleton that survives restarts via SQLite, and on boot
  // sweeps dangling `running` entries from the previous gateway process.
  setQueueEventBroadcaster(broadcast);
  startQueueOrchestrator();
  // Goal runs share queue.db + the broadcaster above; the runner resumes /
  // re-checks any runs that were in flight before a restart.
  startGoalRunner();
  // Scheduled agent tasks drive goal runs, so they start after the runner.
  startScheduledTasks();

  // Wire the satellite's local broadcaster so master-forwarded events
  // (event.forward — agent text deltas, terminal output, tool calls for
  // runs that originated here via federation.node.invoke({nodeId:"master"}))
  // re-broadcast onto this gateway's WS for UI clients.
  //
  // CRITICAL: pass `rawBroadcast`, not `broadcast`. The wrapped `broadcast`
  // tees certain events (terminal.output, terminal.created, etc.) UP to
  // master via the federation WS — using it for event.forward re-emit
  // would create an infinite loop: master forwards an event to us, we
  // re-broadcast, the wrapper tees it back to master, master forwards
  // again, repeat. rawBroadcast goes only to local UI clients, which is
  // exactly what we want for events that originated on another node.
  if (attachedSatellite) {
    try {
      attachedSatellite.setLocalBroadcaster({ broadcast: rawBroadcast });
      params.log.info(
        "[FEDERATION] satellite local broadcaster wired — master events will re-emit to local UI",
      );
    } catch (err) {
      params.log.warn(
        `[FEDERATION] setLocalBroadcaster failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Generic gateway proxy — master forwards arbitrary RPCs (terminal.*,
    // anything the local gateway exposes) and we relay through callGateway.
    // This is the workhorse for cross-device PTY: terminal.create on the
    // satellite, terminal.write/resize keystrokes from the master, etc.
    //
    // Registered against the RESOLVED satellite (not the local var) so it
    // attaches in BOTH startup paths — runtime-state-created and CLI
    // satellite-mode. Helper is idempotent on the same instance.
    attachGatewayProxyRequestListener(attachedSatellite);
  }

  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();

  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    federationHub,
    clients,
    broadcast,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
  };
}

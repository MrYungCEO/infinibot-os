/**
 * Gateway Satellite Mode
 *
 * Handles running the gateway in satellite mode, connecting to a master hub
 * while still serving local clients.
 */

import { applyShareToCapabilities } from "../../federation/share-policy.js";
import { satelliteTokenFromConfig } from "../../federation/security.js";
import { hostname } from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  FederationSatellite,
  setFederationSatellite,
  type SatelliteConfig,
} from "../../federation/satellite.js";
import type { GatewayServer } from "../../gateway/server.js";
import { startGatewayServer } from "../../gateway/server.js";

const log = createSubsystemLogger("federation").child("satellite-mode");

/**
 * Normalize a master URL from config/CLI into a federation WebSocket URL.
 *
 * Maps http(s):// → ws(s):// and only prepends ws:// when there's no scheme
 * at all. Blindly prepending ws:// to an https:// URL yields a URL whose
 * hostname parses as literally "https" — guaranteed getaddrinfo ENOTFOUND.
 * Appends `/federation` when no path is present. Mirrors satellite-cli's
 * `formatMasterUrl` and server-runtime-state's `normalizeMasterUrl` so every
 * satellite-startup path produces the same final URL.
 *
 * Throws `Invalid master URL` when the result can't be parsed.
 */
export function formatMasterUrl(input: string): string {
  let masterUrl = input;
  if (masterUrl.startsWith("http://")) {
    masterUrl = `ws://${masterUrl.slice("http://".length)}`;
  } else if (masterUrl.startsWith("https://")) {
    masterUrl = `wss://${masterUrl.slice("https://".length)}`;
  } else if (!masterUrl.startsWith("ws://") && !masterUrl.startsWith("wss://")) {
    masterUrl = `ws://${masterUrl}`;
  }
  try {
    const url = new URL(masterUrl);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/federation";
    }
    return url.toString();
  } catch {
    throw new Error(`Invalid master URL: ${input}`);
  }
}

export interface SatelliteModeOptions {
  masterUrl: string;
  port?: number;
  bind?: "loopback" | "lan" | "tailnet" | "auto" | "custom";
  auth?: {
    mode?: "token" | "password";
    token?: string;
    password?: string;
  };
  nodeName?: string;
  workspace?: string;
  verbose?: boolean;
  autoDiscover?: boolean;
  discoveryTimeoutMs?: number;
}

export interface SatelliteModeResult {
  gateway: GatewayServer;
  satellite: FederationSatellite;
  close: () => Promise<void>;
}

/**
 * Run gateway in satellite mode.
 *
 * This starts the local gateway AND connects to a master federation hub.
 * The satellite receives state updates from the master and can route
 * tasks to the master's compute resources.
 */
export async function runSatelliteMode(
  opts: SatelliteModeOptions,
  runtime: RuntimeEnv,
): Promise<SatelliteModeResult> {
  const cfg = loadConfig();

  // Resolve master URL (unless using auto-discovery)
  let masterUrl = opts.masterUrl;

  if (!opts.autoDiscover && masterUrl !== "auto") {
    masterUrl = formatMasterUrl(masterUrl);
  }

  // Get node configuration
  const nodeName = opts.nodeName ?? cfg.federation?.nodeName ?? hostname();
  const workspace = opts.workspace ?? process.cwd();

  log.info(`starting satellite mode, master: ${masterUrl}`);

  // Create satellite client
  // Other addresses of the same master (Tailscale DNS/IP, LAN) from the
  // invite — the satellite rotates through them when one stops answering.
  const alternates = (cfg.federation?.masters ?? [])
    .map((u) => {
      try {
        return formatMasterUrl(u);
      } catch {
        return "";
      }
    })
    .filter((u) => u && u !== masterUrl);
  const satelliteConfig: SatelliteConfig = {
    masterUrl,
    ...(alternates.length ? { masters: [masterUrl, ...alternates] } : {}),
    nodeName,
    workspace,
    capabilities: applyShareToCapabilities(cfg.federation?.share, {
      hasOllama: cfg.federation?.capabilities?.hasOllama ?? false,
      hasComfyUI: cfg.federation?.capabilities?.hasComfyUI ?? false,
      hasVoice: cfg.federation?.capabilities?.hasVoice ?? false,
      mcpServers: [], // MCP servers are discovered at runtime
      agents: cfg.agents ? Object.keys(cfg.agents) : [],
    }),
    authToken: satelliteTokenFromConfig(cfg.federation?.authToken),
    share: cfg.federation?.share,
    autoReconnect: true,
    autoDiscover: opts.autoDiscover || opts.masterUrl === "auto",
    discoveryTimeoutMs: opts.discoveryTimeoutMs ?? 10000,
  };

  const satellite = new FederationSatellite(satelliteConfig);
  // Register this satellite as the process singleton BEFORE we start the
  // gateway server. server-runtime-state inspects the singleton during
  // its own init and skips creating a duplicate satellite when one is
  // already running.
  setFederationSatellite(satellite);

  // Set up satellite event handlers
  satellite.on("connected", (nodeId) => {
    log.info(`connected to master as ${nodeId}`);
  });

  satellite.on("disconnected", (reason) => {
    log.warn(`disconnected from master: ${reason}`);
  });

  satellite.on("state:sync", (payload) => {
    log.info(`state synced, ${payload.nodes.length} nodes in federation`);
  });

  satellite.on("error", (err) => {
    log.error(`satellite error: ${err.message}`);
  });

  // Track running sessions for completion callbacks
  const runningSessions = new Map<
    string,
    { correlationId: string; sessionKey: string; runId: string }
  >();

  // Handle session spawn requests from master
  satellite.on("session:spawn:request", async (request: Record<string, unknown>) => {
    const correlationId = request.correlationId as string | undefined;
    const agentId = (request.agentId as string) || "coder";
    const task = (request.task as string) || "";
    const label = (request.label as string) || `remote-${agentId}-${Date.now()}`;

    log.info(`[SPAWN] Received request from master`, {
      correlationId,
      agentId,
      label,
      taskPreview: task.substring(0, 100),
      satelliteState: satellite.getState(),
    });

    try {
      // Route through sessions.spawn so satellite honours its agent config
      // (execution.mode === "terminal" → CLI tool, else agent-loop)
      const { callGateway } = await import("../../gateway/call.js");

      log.info(`[SPAWN] Calling local gateway`, { method: "sessions.spawn", agentId, label });

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
        // sessions.spawn returned without the keys we need — surface the error
        // rather than fabricating a phantom key that exists nowhere.
        const detailMsg = `sessions.spawn returned status=${response?.status ?? "unknown"} without childSessionKey/runId`;
        log.error(`[SPAWN] Error: ${detailMsg}`, { correlationId, agentId, response });
        if (correlationId) {
          satellite.sendSessionResult("session.spawn.result", correlationId, {
            success: false,
            error: detailMsg,
          });
        }
        return;
      }

      log.info(`[SPAWN] Local gateway accepted`, {
        sessionKey,
        actualRunId,
        responseStatus: response?.status,
        correlationId,
      });

      // Track the running session if we have a correlationId
      if (correlationId) {
        runningSessions.set(actualRunId, {
          correlationId,
          sessionKey,
          runId: actualRunId,
        });
        log.debug(`[SPAWN] Tracking session for completion: ${actualRunId} -> ${correlationId}`);
      }

      // Send success result back to master
      log.info(`[SPAWN] Sending success result to master`, {
        correlationId,
        sessionKey,
        actualRunId,
      });
      satellite.sendSessionResult("session.spawn.result", correlationId || actualRunId, {
        success: true,
        sessionKey,
        runId: actualRunId,
      });
      log.info(`[SPAWN] Success result sent`, { correlationId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log.error(`[SPAWN] Failed to spawn remote session`, {
        error,
        stack,
        correlationId,
        agentId,
        satelliteState: satellite.getState(),
      });

      // Send error result back to master
      if (correlationId) {
        log.info(`[SPAWN] Sending error result to master`, { correlationId, error });
        satellite.sendSessionResult("session.spawn.result", correlationId, {
          success: false,
          error,
        });
      } else {
        log.warn(`[SPAWN] No correlationId to send error result`);
      }
    }
  });

  // Listen for agent lifecycle events to detect completion
  try {
    const { onAgentEvent } = await import("../../infra/agent-events.js");

    const unsubscribe = onAgentEvent((event) => {
      if (
        event.stream === "lifecycle" &&
        event.data?.phase === "end" &&
        runningSessions.has(event.runId)
      ) {
        const session = runningSessions.get(event.runId)!;
        log.info(
          `agent completed, sending completion callback: ${event.runId} -> ${session.correlationId}`,
        );

        // Send completion notification back to master
        satellite.sendSessionComplete(session.correlationId, {
          sessionKey: session.sessionKey,
          runId: session.runId,
          success: true, // Lifecycle end means successful completion
          result: "Task completed",
        });

        // Clean up tracking
        runningSessions.delete(event.runId);
      }
    });

    log.info("registered agent lifecycle listener for completion callbacks");

    // Clean up listener when satellite disconnects
    satellite.on("disconnected", () => {
      unsubscribe();
      log.debug("unregistered agent lifecycle listener");
    });
  } catch (err) {
    log.warn(
      `failed to register agent lifecycle listener: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Handle session send requests from master
  satellite.on("session:send:request", async (request: Record<string, unknown>) => {
    log.info(`received session send request from master`);

    const correlationId = request.correlationId as string | undefined;
    const sessionKey = request.sessionKey as string;
    const message = request.message as string;

    try {
      const { callGateway } = await import("../../gateway/call.js");

      // chat.send is the gateway's "deliver a user message into a session
      // and start the agent" method. sessions.send only enqueues a
      // [USER INPUT] system event without triggering a run, so federation
      // replies never streamed back. Mirror the server-runtime-state path
      // which has been the working dispatch since the federation pipe was
      // wired up. correlationId is the master's messageId — unique per
      // message — so we reuse it as idempotencyKey for natural retry safety.
      const idempotencyKey =
        correlationId ??
        `federation-${sessionKey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = (await callGateway({
        method: "chat.send",
        params: { sessionKey, message, idempotencyKey },
        timeoutMs: 30_000,
      })) as { reply?: string };

      if (correlationId) {
        satellite.sendSessionResult("session.send.result", correlationId, {
          success: true,
          reply: response?.reply,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`failed to send to session: ${error}`);

      if (correlationId) {
        satellite.sendSessionResult("session.send.result", correlationId, {
          success: false,
          error,
        });
      }
    }
  });

  // Start the local gateway
  const port = opts.port ?? cfg.gateway?.port ?? 18789;
  const gateway = await startGatewayServer(port, {
    bind: opts.bind,
    auth: opts.auth,
  });

  log.info(`local gateway started on port ${port}`);

  // Connect to master
  try {
    await satellite.connect();
  } catch (err) {
    // If we can't connect to master, continue in degraded mode
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to connect to master: ${message} (running in degraded mode)`);
    runtime.log(`Warning: Failed to connect to master federation hub: ${message}`);
    runtime.log("Running in degraded mode - will retry connection automatically");
  }

  // Create close handler
  const close = async () => {
    log.info("shutting down satellite mode...");
    await satellite.disconnect();
    await gateway.close();
    log.info("satellite mode shutdown complete");
  };

  // Handle process signals
  const handleSignal = async () => {
    await close();
    process.exit(0);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  return {
    gateway,
    satellite,
    close,
  };
}

/**
 * Check if satellite mode is requested based on config or CLI options.
 */
export function shouldRunSatelliteMode(opts: { satellite?: boolean; master?: string }): boolean {
  if (opts.satellite === true) return true;
  if (typeof opts.master === "string" && opts.master.trim().length > 0) return true;

  const cfg = loadConfig();
  return cfg.federation?.mode === "satellite" && Boolean(cfg.federation?.masterUrl);
}

/**
 * Get master URL from options or config.
 */
export function getMasterUrl(opts: { master?: string }): string | null {
  if (typeof opts.master === "string" && opts.master.trim().length > 0) {
    return opts.master.trim();
  }

  const cfg = loadConfig();
  if (cfg.federation?.mode === "satellite" && cfg.federation?.masterUrl) {
    return cfg.federation.masterUrl;
  }

  return null;
}

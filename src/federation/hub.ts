/**
 * Federation Hub
 *
 * Central hub for managing satellite node connections in a federated InfiniBot network.
 * The hub runs on the master node and handles:
 * - WebSocket connections from satellite nodes
 * - Node registration and capability tracking
 * - State synchronization across the federation
 * - Compute routing requests
 * - Cross-node session management
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname as osHostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig } from "../config/config.js";
import { getLastOllamaStatus } from "../ollama/ensure-ollama.js";
import type {
  NodeManifest,
  NodeCapabilities,
  SessionSpawnRequest,
  SessionSendRequest,
  SessionHandle,
  StateUpdate,
  StateSyncPayload,
  ComputeRequirements,
  FederationMessage,
  MCPServerInfo,
  MCPListResult,
  MCPInvokeRequest,
  MCPInvokeResult,
  NodeLoadMetrics,
  MigrationRequest,
  MigrationResult,
  FleetHealthSummary,
  RetryConfig,
  TaskQueueConfig,
  QueuePriority,
  QueueStats,
  FailoverConfig,
  PeerDiscoveryResult,
} from "./types.js";
import { FederationLoadBalancer, initLoadBalancer } from "./load-balancer.js";
import { ResourceMonitor, initResourceMonitor } from "./resource-monitor.js";
import type { HardwareSnapshot as HardwareSnapshotPayload } from "./hardware-collector.js";
import { type FederationEventBus, getEventBus, type FederationEvent } from "./event-bus.js";
import { RetryManager } from "./retry-manager.js";
import { TaskQueue, initTaskQueue } from "./task-queue.js";
import { FailoverManager } from "./failover-manager.js";
import { parseCapabilityRequirements, routeByCapabilities } from "./capability-router.js";
import { initHealthTracker, type HealthTracker } from "./health-tracker.js";
import { MessageOptimizer, createMessageOptimizer } from "./message-optimizer.js";
import {
  FEDERATION_PROTOCOL_VERSION,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_HEARTBEAT_TIMEOUT,
  deserializeMessage,
  buildRegisterAckMessage,
  buildHeartbeatAckMessage,
  buildStateSyncAckMessage,
  buildStateUpdateMessage,
  buildErrorMessage,
  buildMCPListResultMessage,
  buildMCPInvokeMessage,
  buildMCPInvokeResultMessage,
  validateMCPInvokePayload,
  isMessageType,
  isValidMessageType,
  validateNodeRegisterPayload,
  getProtocolCompatibility,
  generateNodeId,
  generateMessageId,
  buildFederationEventMessage,
  buildDeliveryAckMessage,
  buildRoleChangeMessage,
} from "./protocol.js";
import type { RegisterAckSecurityPayload } from "./protocol.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { getDeadLetterQueue } from "./dead-letter-queue.js";
import { broadcastFederationEvent } from "./events.js";
import { sendWebSocketMessage } from "./ws-send.js";
import { ComputeRouter } from "./router.js";
import { updateCapabilityRouterMetrics } from "./capability-router.js";
import { FederationError, FederationErrorCode } from "./types.js";
import { getMigrationManager, type DetailedMigrationResult } from "./session-migration.js";
import { StateSyncManager } from "./state-sync.js";
import type { StateSyncMessage, SyncableResource } from "./types.js";
import { IdentitySyncManager, initIdentitySyncManager } from "./identity-sync.js";
import {
  MemorySyncManager,
  initMemorySyncManager,
  type MemoryUpdateMessage,
} from "./memory-sync.js";
import { MemoryFileWatcher, initFileWatcher } from "./file-watcher.js";
import {
  FederationDiscoveryManager,
  type MDNSServiceConfig,
  isDiscoveryAvailable,
} from "./discovery.js";
import {
  FederationSecurity,
  getFederationSecurity,
  type SatelliteToken,
  type PermissionLevel,
  type OperationType,
  DEFAULT_PERMISSIONS,
} from "./security.js";
import { getFederationAuditLogger, type AuditEventType } from "./audit-log.js";
import { pushStreamChunk, pushStreamError, type StreamChunk } from "./hub-forward.js";
import { removeRemoteSessionsForNode } from "./remote-session-registry.js";
import { appendSpawnEvent } from "../agents/spawn-ledger.js";
import { revokedSatelliteIds, upsertPairedDevice, tokenFingerprint } from "./paired-devices.js";

/** TTL/size bound for the tunneled handlers' dedupe map (mirrors the gateway's own). */
export const TUNNELED_DEDUPE_TTL_MS = 5 * 60_000;
export const TUNNELED_DEDUPE_MAX = 1000;

/**
 * Tunneled agent/chat/send handlers write `{ ts, ok, payload }` (payload can be
 * a full agent result) per idempotency key. The gateway prunes its own dedupe
 * map in server-maintenance, but this one was never pruned and grew for every
 * satellite request. Called before each tunneled dispatch.
 */
export function pruneTunneledDedupe(dedupe: Map<string, unknown>, now = Date.now()): void {
  const tsOf = (v: unknown) =>
    v && typeof v === "object" && typeof (v as { ts?: unknown }).ts === "number"
      ? (v as { ts: number }).ts
      : 0;
  for (const [k, v] of dedupe) {
    if (now - tsOf(v) > TUNNELED_DEDUPE_TTL_MS) dedupe.delete(k);
  }
  if (dedupe.size > TUNNELED_DEDUPE_MAX) {
    // Map iteration is insertion order: drop the oldest first.
    let excess = dedupe.size - TUNNELED_DEDUPE_MAX;
    for (const k of dedupe.keys()) {
      if (excess-- <= 0) break;
      dedupe.delete(k);
    }
  }
}

const log = createSubsystemLogger("federation").child("hub");

/**
 * Resolved-once package version, read from the repo's package.json relative to
 * this module. Cached so repeated reads (e.g. discovery advertisement) don't
 * touch the filesystem per call. Falls back to "0.0.0" if unreadable.
 */
let cachedPackageVersion: string | null = null;
function getPackageVersion(): string {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cachedPackageVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedPackageVersion = "0.0.0";
  }
  return cachedPackageVersion;
}

// =============================================================================
// Types
// =============================================================================

/** Connected satellite node */
export interface ConnectedNode {
  /** Unique node ID */
  id: string;
  /** Node manifest with capabilities */
  manifest: NodeManifest;
  /** WebSocket connection */
  socket: WebSocket;
  /** Connection timestamp */
  connectedAt: number;
  /** Last heartbeat timestamp */
  lastHeartbeat: number;
  /** Heartbeat interval timer */
  heartbeatTimer?: NodeJS.Timeout;
  /** Current load (0-100) */
  currentLoad: number;
  /** Active session count */
  activeSessions: number;
  /** Protocol version negotiated */
  protocolVersion: number;
  /** Connection state */
  state: "connecting" | "registered" | "disconnecting";
}

/** Hub configuration */
export interface FederationHubConfig {
  /** Port for federation WebSocket (default: 47913) */
  port?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Heartbeat timeout in ms (default: 10000) */
  heartbeatTimeoutMs?: number;
  /** Maximum message size in bytes (default: 10MB) */
  maxPayloadBytes?: number;
  /** Local node manifest for the master */
  localManifest?: NodeManifest;
  /** Existing HTTP server to attach to (optional) */
  httpServer?: http.Server;
  /** Path for WebSocket upgrade (default: /federation) */
  wsPath?: string;
  /** Workspace path for identity files (SOUL.md, MEMORY.md, etc.) */
  workspace?: string;
  /** Sync gateway password to satellites (default: true) */
  syncGatewayPassword?: boolean;
  /** Enable mDNS advertisement for auto-discovery (default: true) */
  enableDiscovery?: boolean;
  /** mDNS service type (default: _infinibot-federation._tcp) */
  discoveryServiceType?: string;
  /** Node name for discovery advertisement (default: hostname) */
  discoveryNodeName?: string;
  /** Gateway password to sync */
  gatewayPassword?: string;
  /** Retry configuration for failed spawn operations */
  retryConfig?: Partial<RetryConfig>;
  /** Task queue configuration */
  taskQueueConfig?: TaskQueueConfig;
  /** Failover configuration for automatic recovery */
  failoverConfig?: Partial<FailoverConfig>;
}

/** Hub events */
export interface FederationHubEvents {
  "node:connected": (node: ConnectedNode) => void;
  "node:disconnected": (nodeId: string, reason: string) => void;
  "node:heartbeat": (nodeId: string, load: number, sessions: number) => void;
  "state:update": (update: StateUpdate) => void;
  "session:spawn": (request: SessionSpawnRequest, fromNode: string) => void;
  "session:send": (request: SessionSendRequest, fromNode: string) => void;
  "file-transfer:message": (
    type: string,
    payload: Record<string, unknown>,
    fromNodeId: string,
  ) => void;
  error: (error: Error) => void;
}

// =============================================================================
// Federation Hub Class
// =============================================================================

export class FederationHub extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private nodes = new Map<string, ConnectedNode>();
  private socketToNode = new Map<WebSocket, string>();
  private config: Required<FederationHubConfig>;
  private router: ComputeRouter;
  private loadBalancer: FederationLoadBalancer;
  private resourceMonitor: ResourceMonitor;
  private eventBus: FederationEventBus;
  private stateVersion = 0;
  private closed = false;
  private localNodeId: string;
  private pendingMigrations = new Map<
    string,
    { resolve: (r: MigrationResult) => void; reject: (e: Error) => void }
  >();
  private stateSyncManager: StateSyncManager | null = null;
  private identitySyncManager: IdentitySyncManager | null = null;
  private memorySyncManager: MemorySyncManager | null = null;
  private fileWatcher: MemoryFileWatcher | null = null;
  private deliveryManager = getDeliveryManager();
  private retryManager: RetryManager;
  private taskQueue: TaskQueue;
  private messageOptimizer: MessageOptimizer;
  private failoverManager: FailoverManager;
  private healthTracker: HealthTracker;
  private security: FederationSecurity;
  private auditLogger = getFederationAuditLogger();
  private discoveryManager: FederationDiscoveryManager | null = null;

  /**
   * Latest HardwareSnapshot per satellite node, pushed via `hardware.snapshot`
   * messages on a 1Hz cadence (throttled satellite-side). Bounded: at most one
   * entry per connected node; cleared on disconnect.
   */
  private satelliteHardware = new Map<
    string,
    { snapshot: HardwareSnapshotPayload; receivedAt: number }
  >();

  /**
   * Per-hub idempotency cache for satellite-tunneled gateway invocations.
   * Shared by every handler dispatched via `handleMasterGatewayInvoke` so
   * the `agent` handler (and other handlers that key off `idempotencyKey`)
   * can dedupe retries. Lives in process memory — no persistence needed,
   * since federation retries already use a delivery layer.
   */
  private tunneledHandlerDedupe = new Map<string, unknown>();

  /**
   * Maps runId → originating satellite nodeId for runs spawned via
   * master.gateway.invoke. When master's gateway later broadcasts events
   * with this runId (text deltas, tool calls, completion), we forward
   * them back to the satellite over the federation WS as event.forward
   * so the satellite's UI receives streaming progress.
   *
   * Populated by handleMasterGatewayInvoke from the handler's response.
   * Cleared on agent.complete / run.complete via maybeForwardEvent.
   */
  private tunneledRunOwners = new Map<string, string>();

  /**
   * Maps sessionKey → originating satellite. Same purpose as
   * tunneledRunOwners but indexed by sessionKey for events that carry
   * a sessionKey but no runId (e.g. multi-turn session.send events).
   */
  private tunneledSessionOwners = new Map<string, string>();

  /**
   * Maps terminalId → originating satellite. Populated when a tunneled
   * call to terminal.create / terminal.spawnAgent returns a terminalId
   * (or id). Lets terminal.output / terminal.created / terminal.exit
   * events — which don't carry runId or sessionKey — get forwarded back
   * to the satellite that spawned the PTY so xterm in its UI receives
   * the bytes. Without this the cross-device TUI was a black box on
   * the satellite UI.
   */
  private tunneledTerminalOwners = new Map<string, string>();

  constructor(config: FederationHubConfig = {}) {
    super();
    this.config = {
      port: config.port ?? 47913,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT,
      maxPayloadBytes: config.maxPayloadBytes ?? 10 * 1024 * 1024,
      localManifest: config.localManifest ?? this.buildLocalManifest(),
      httpServer: config.httpServer as http.Server,
      wsPath: config.wsPath ?? "/federation",
      workspace: config.workspace ?? process.cwd(),
      syncGatewayPassword: config.syncGatewayPassword ?? true,
      gatewayPassword: config.gatewayPassword ?? "",
      retryConfig: config.retryConfig ?? {},
      taskQueueConfig: config.taskQueueConfig ?? {},
      failoverConfig: config.failoverConfig ?? {},
      enableDiscovery: config.enableDiscovery ?? true,
      discoveryServiceType: config.discoveryServiceType ?? "_infinibot-federation._tcp",
      discoveryNodeName: config.discoveryNodeName ?? osHostname(),
    };
    this.localNodeId = this.config.localManifest.id;
    this.router = new ComputeRouter({
      masterId: this.localNodeId,
      localNodeId: this.localNodeId,
    });

    // Initialize load balancer
    this.loadBalancer = initLoadBalancer({
      metricsIntervalMs: this.config.heartbeatIntervalMs,
    });

    // Initialize resource monitor for local (master) node
    this.resourceMonitor = initResourceMonitor(this.localNodeId, {
      metricsIntervalMs: this.config.heartbeatIntervalMs,
    });

    // Update load balancer and routers when local metrics change
    this.resourceMonitor.on("metrics", (metrics: NodeLoadMetrics) => {
      this.loadBalancer.updateMetrics(this.localNodeId, metrics);
      this.router.updateNodeMetrics(this.localNodeId, metrics);
      updateCapabilityRouterMetrics(this.localNodeId, metrics);
    });

    // Register local master node with router and load balancer
    this.router.registerNode(this.config.localManifest);
    this.loadBalancer.registerNode(this.config.localManifest);

    // Initialize event bus and connect it to this hub
    this.eventBus = getEventBus();
    this.eventBus.setNodeId(this.localNodeId);
    this.eventBus.setHub(this);

    // Initialize health tracker for monitoring node health
    this.healthTracker = initHealthTracker({
      quarantineThreshold: 20, // Quarantine below 20% health
      unquarantineThreshold: 50, // Unquarantine above 50% health
      trackingWindowMs: 30 * 60 * 1000, // 30 minutes tracking window
    });

    // Add local master node to health tracking
    this.healthTracker.addNode(this.localNodeId);

    // Initialize security manager
    this.security = getFederationSecurity();
    // Devices removed on the master stay removed across restarts.
    try {
      for (const id of revokedSatelliteIds()) this.security.revokeSatelliteToken(id);
    } catch {
      /* no paired-devices file yet */
    }

    // Initialize identity sync manager for pushing soul/memory files to satellites
    if (config.workspace) {
      this.identitySyncManager = initIdentitySyncManager({
        nodeId: this.localNodeId,
        workspace: config.workspace,
        syncPassword: config.syncGatewayPassword ?? true,
        gatewayPassword: config.gatewayPassword,
      });
      this.identitySyncManager.setHub(this);
      log.info("Identity sync enabled - will push SOUL.md, MEMORY.md, etc. to satellites");

      // Initialize memory sync manager for bidirectional memory sync
      this.memorySyncManager = initMemorySyncManager({
        workspace: config.workspace,
        nodeId: this.localNodeId,
        conflictResolution: "last-write-wins",
      });
      this.memorySyncManager.setHub(this);

      // Initialize file watcher for detecting identity and memory changes
      this.fileWatcher = initFileWatcher({
        workspace: config.workspace,
        debounceMs: 500,
        watchDailyNotes: true,
        additionalFiles: [], // Include all identity files by default
      });
      this.memorySyncManager.setFileWatcher(this.fileWatcher);
      this.identitySyncManager.setFileWatcher(this.fileWatcher);

      log.info("Memory sync enabled - bidirectional sync for MEMORY.md and daily notes");
      log.info(
        "Identity sync auto-trigger enabled - will auto-sync SOUL.md, AGENTS.md, etc. on changes",
      );
    }

    // Initialize retry manager for spawn operations
    this.retryManager = new RetryManager(
      // Spawn function - this will be the actual spawn implementation
      (request: SessionSpawnRequest) => this.directSpawnRemoteSession(request),
      // Node selector function - get available nodes excluding certain ones
      (excludeNodes?: Set<string>) => this.getAvailableNodes(excludeNodes),
      // Retry configuration
      config.retryConfig,
    );

    log.info("RetryManager initialized for spawn operations");

    // Initialize task queue for capacity-based queuing
    this.taskQueue = initTaskQueue(config.taskQueueConfig);

    // Handle dequeue events from task queue
    this.taskQueue.on(
      "dequeue",
      async (event: {
        itemId: string;
        nodeId: string;
        request: SessionSpawnRequest;
        resolve: (result: SessionHandle) => void;
        reject: (error: Error) => void;
      }) => {
        try {
          log.debug("Processing dequeued task", { itemId: event.itemId, nodeId: event.nodeId });
          const result = await this.directSpawnRemoteSession(event.request);
          event.resolve(result);
        } catch (error) {
          log.error("Failed to process dequeued task", {
            itemId: event.itemId,
            nodeId: event.nodeId,
            error,
          });
          event.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );

    log.info("TaskQueue initialized for spawn operations");

    // Initialize failover manager for automatic session recovery
    this.failoverManager = new FailoverManager({
      config: this.config.failoverConfig,
      router: this.router,
      loadBalancer: this.loadBalancer,
      getConnectedNodes: () => this.getConnectedNodes().map((n) => n.manifest),
      spawnSession: (request: SessionSpawnRequest) => this.directSpawnRemoteSession(request),
      notifySession: async (nodeId: string, sessionKey: string, notification) => {
        await this.notifySessionEvent(nodeId, sessionKey, "failover", {
          notification: notification as unknown as Record<string, unknown>,
        });
      },
    });

    // Listen for failover events
    this.failoverManager.on("failover.started", (sessionKey, failedNodeId) => {
      log.info(`failover started for session ${sessionKey} from failed node ${failedNodeId}`);
    });

    this.failoverManager.on("failover.success", (sessionKey, newSessionKey, targetNodeId) => {
      log.info(`failover succeeded: ${sessionKey} -> ${newSessionKey} on ${targetNodeId}`);
    });

    this.failoverManager.on("failover.failure", (sessionKey, error) => {
      log.error(`failover failed for session ${sessionKey}: ${error}`);
    });

    log.info("FailoverManager initialized for session recovery");

    // Initialize message optimizer for batching and compression
    this.messageOptimizer = createMessageOptimizer(this.localNodeId, {
      compressionEnabled: true,
      batchingEnabled: true,
    });

    log.info("Message optimizer initialized - batching and compression enabled");
  }

  /**
   * Update gateway password for identity sync.
   */
  setGatewayPassword(password: string): void {
    if (this.identitySyncManager) {
      this.identitySyncManager.setGatewayPassword(password);
    }
  }

  /**
   * Push identity (soul/memory files + password) to all connected satellites.
   */
  async pushIdentityToAll(): Promise<{ success: number; failed: number }> {
    if (!this.identitySyncManager) {
      log.warn("Identity sync not enabled - no workspace configured");
      return { success: 0, failed: 0 };
    }
    return this.identitySyncManager.pushIdentityToAll();
  }

  /**
   * Handle a satellite-initiated request for a fresh identity push. The
   * normal flow auto-syncs on connect + on file change; this lets the UI
   * trigger an explicit pull (e.g. user clicked "Pull from master" in the
   * Memory tab) without reconnecting the satellite.
   *
   * No-op if identity sync isn't configured or the requesting node isn't
   * registered (the message handler already verified registration before this
   * is called, so the second check is just defensive).
   */
  private handleIdentitySyncRequest(nodeId: string): void {
    if (!this.identitySyncManager) {
      log.debug(`identity.sync.request from ${nodeId} ignored — sync not configured`);
      return;
    }
    const node = this.nodes.get(nodeId);
    if (!node) {
      log.debug(`identity.sync.request from unknown node ${nodeId}`);
      return;
    }
    log.info(`identity.sync.request from ${nodeId} — pushing fresh snapshot`);
    this.identitySyncManager.pushIdentityToNode(node).catch((err) => {
      log.error(
        `Failed to fulfill identity.sync.request from ${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Get the event bus instance
   */
  getEventBus(): FederationEventBus {
    return this.eventBus;
  }

  /**
   * Broadcast a federation event to all connected satellites
   */
  broadcastEvent(event: FederationEvent): void {
    const message = buildFederationEventMessage(this.localNodeId, event);

    for (const node of this.nodes.values()) {
      if (node.state !== "registered") continue;
      try {
        node.socket.send(message);
      } catch (err) {
        log.warn(`failed to send event to node ${node.id}: ${err}`);
      }
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the federation hub.
   * Either creates a new WebSocket server or attaches to an existing HTTP server.
   */
  async start(): Promise<void> {
    const fs = await import("fs");
    const hubDebug = (msg: string) =>
      fs.appendFileSync("C:\\tmp\\hub-debug.log", `${new Date().toISOString()} ${msg}\n`);

    hubDebug("start() called");
    if (this.wss) {
      hubDebug("Already started, throwing");
      throw new Error("Federation hub already started");
    }

    hubDebug(`httpServer=${!!this.config.httpServer}, wsPath=${this.config.wsPath}`);
    if (this.config.httpServer) {
      // Attach to existing HTTP server with path filter
      hubDebug("Creating noServer WebSocketServer...");
      this.wss = new WebSocketServer({
        noServer: true,
        maxPayload: this.config.maxPayloadBytes,
      });
      hubDebug("WebSocketServer created");

      hubDebug("Attaching upgrade handler...");
      this.config.httpServer.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
        hubDebug(`Upgrade request: pathname=${url.pathname}, wsPath=${this.config.wsPath}`);
        if (url.pathname === this.config.wsPath) {
          hubDebug("Path matches! Handling upgrade...");
          this.wss!.handleUpgrade(request, socket, head, (ws) => {
            hubDebug("Upgrade complete, emitting connection");
            this.wss!.emit("connection", ws, request);
          });
        } else {
          hubDebug("Path mismatch, ignoring");
        }
      });
      hubDebug("Upgrade handler attached");

      log.info(`federation hub attached to existing server on path ${this.config.wsPath}`);
      hubDebug(`federation hub attached to existing server on path ${this.config.wsPath}`);
    } else {
      // Create standalone WebSocket server
      this.wss = new WebSocketServer({
        port: this.config.port,
        maxPayload: this.config.maxPayloadBytes,
      });

      log.info(`federation hub listening on port ${this.config.port}`);
    }

    this.wss.on("connection", (socket, request) => {
      this.handleConnection(socket, request);
    });

    this.wss.on("error", (error) => {
      log.error(`federation hub error: ${error.message}`);
      this.emit("error", error);
    });

    // Start resource monitoring for local node
    this.resourceMonitor.start();

    // Start fleet health checks
    this.loadBalancer.startHealthChecks(this.config.heartbeatIntervalMs * 2);

    // Initialize state sync manager
    this.stateSyncManager = new StateSyncManager({
      nodeId: this.localNodeId,
      hub: this,
      workspace: this.config.localManifest.workspace,
      config: {
        autoSync: true,
        syncIntervalMs: 30000,
        resources: ["memory", "kanban"],
        conflictResolution: "last-write-wins",
      },
    });
    this.stateSyncManager.start();
    log.info("State sync manager started");

    // Start file watcher for memory sync if enabled
    if (this.fileWatcher) {
      await this.fileWatcher.start();
      log.info("Memory file watcher started");
    }

    // Start mDNS discovery advertisement if enabled
    if (this.config.enableDiscovery && (await isDiscoveryAvailable())) {
      try {
        this.discoveryManager = new FederationDiscoveryManager();
        // Attached to the gateway's HTTP server, the hub serves on the
        // gateway port, not `config.port` (47913): advertise where satellites
        // can actually reach /federation.
        const attachedAddr = this.config.httpServer?.address();
        const advertisedPort =
          attachedAddr && typeof attachedAddr === "object" ? attachedAddr.port : this.config.port;
        const discoveryConfig: MDNSServiceConfig = {
          serviceType: this.config.discoveryServiceType,
          port: advertisedPort,
          nodeId: this.config.localManifest.id,
          nodeName: this.config.discoveryNodeName,
          version: getPackageVersion(),
          capabilities: this.config.localManifest.capabilities,
        };

        await this.discoveryManager.startAdvertising(discoveryConfig);
        log.info("mDNS discovery advertisement started", {
          serviceType: this.config.discoveryServiceType,
          port: advertisedPort,
          nodeName: this.config.discoveryNodeName,
        });
      } catch (err) {
        log.error("Failed to start mDNS discovery advertisement", { error: err });
        // Continue without discovery - not critical
      }
    } else if (this.config.enableDiscovery && !(await isDiscoveryAvailable())) {
      log.warn("mDNS discovery requested but not available (missing @homebridge/ciao)");
    }
  }

  /**
   * Stop the federation hub and disconnect all nodes.
   */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    log.info("stopping federation hub...");

    // Stop monitoring
    this.resourceMonitor.stop();
    this.loadBalancer.stopHealthChecks();

    // Stop state sync manager
    if (this.stateSyncManager) {
      this.stateSyncManager.stop();
      this.stateSyncManager = null;
    }

    // Stop memory file watcher
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher = null;
    }

    // Stop mDNS discovery advertisement
    if (this.discoveryManager) {
      try {
        await this.discoveryManager.destroy();
        this.discoveryManager = null;
        log.info("mDNS discovery advertisement stopped");
      } catch (err) {
        log.error("Error stopping mDNS discovery advertisement", { error: err });
      }
    }

    // Stop retry manager
    this.retryManager.destroy();

    // Stop task queue
    this.taskQueue.stop();

    // Shutdown message optimizer
    this.messageOptimizer.shutdown();

    // Disconnect all nodes
    for (const [nodeId, node] of this.nodes) {
      this.disconnectNode(nodeId, "hub shutting down");
    }

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    log.info("federation hub stopped");
  }

  // ===========================================================================
  // Node Management
  // ===========================================================================

  /**
   * Register a satellite node with its manifest.
   */
  registerNode(manifest: NodeManifest, socket: WebSocket): ConnectedNode {
    const nodeId = manifest.id;

    // Check for existing connection from same node
    const existing = this.nodes.get(nodeId);
    if (existing) {
      log.warn(`node ${nodeId} reconnecting, closing old connection`);
      this.disconnectNode(nodeId, "superseded by new connection");
    }

    const node: ConnectedNode = {
      id: nodeId,
      manifest,
      socket,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      currentLoad: 0,
      activeSessions: 0,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      state: "registered",
    };

    this.nodes.set(nodeId, node);
    this.socketToNode.set(socket, nodeId);

    // Register with compute router
    this.router.registerNode(manifest);

    // Register with load balancer
    this.loadBalancer.registerNode(manifest);

    // Register with health tracker
    this.healthTracker.addNode(nodeId);
    this.healthTracker.recordConnection(nodeId, "connect");

    // Start heartbeat monitoring
    this.startHeartbeatMonitor(node);

    log.info(`node registered: ${manifest.name} (${nodeId})`);
    this.emit("node:connected", node);
    broadcastFederationEvent("federation.peer.connected", {
      peerNodeId: nodeId,
      ts: Date.now(),
    });

    // Publish node connected event to federation event bus
    this.eventBus.publish("node.connected", {
      nodeId,
      name: manifest.name,
      hostname: manifest.hostname,
      capabilities: manifest.capabilities,
    });

    // Broadcast state update to all nodes
    this.broadcastStateUpdate();

    // Trigger state sync when a new node connects
    if (this.stateSyncManager) {
      this.stateSyncManager.fullSync().catch((err) => {
        log.error(`Full sync failed after node ${nodeId} connected:`, err);
      });
    }

    // Replay any session-event notifications queued while this node was offline.
    this.replayQueuedSessionEvents(nodeId);

    const restored = this.deliveryManager.retryPendingForTarget(nodeId, async (msg) => {
      await this.sendRawToRegisteredNode(nodeId, JSON.stringify(msg));
    });
    if (restored > 0) {
      log.info("replayed persisted pending federation deliveries", { nodeId, count: restored });
    }

    return node;
  }

  /**
   * Disconnect a node.
   */
  disconnectNode(nodeId: string, reason: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.state = "disconnecting";

    // Stop heartbeat monitor
    if (node.heartbeatTimer) {
      clearInterval(node.heartbeatTimer);
    }

    // Close socket
    try {
      node.socket.close(1000, reason);
    } catch {
      // Ignore close errors
    }

    // Remove from registries
    this.nodes.delete(nodeId);
    this.socketToNode.delete(node.socket);
    this.router.unregisterNode(nodeId);
    this.loadBalancer.unregisterNode(nodeId);
    this.satelliteHardware.delete(nodeId);
    this.cleanupRemoteSessionsForDisconnectedNode(nodeId, reason);

    // Record disconnection in health tracker
    this.healthTracker.recordConnection(nodeId, "disconnect", reason);

    log.info(`node disconnected: ${nodeId} (${reason})`);
    this.emit("node:disconnected", nodeId, reason);
    broadcastFederationEvent("federation.peer.disconnected", {
      peerNodeId: nodeId,
      ts: Date.now(),
    });

    // Trigger failover for sessions on the failed node (async, don't block disconnection)
    if (reason === "heartbeat timeout" || reason.includes("timeout") || reason.includes("error")) {
      setImmediate(async () => {
        try {
          await this.failoverManager.handleNodeFailure(nodeId, reason);
        } catch (error) {
          log.error(`failover handling failed for node ${nodeId}`, { error });
        }
      });
    }

    // Publish node disconnected event to federation event bus
    this.eventBus.publish("node.disconnected", {
      nodeId,
      name: node.manifest.name,
      reason,
    });

    // Broadcast state update
    this.broadcastStateUpdate();
  }

  private cleanupRemoteSessionsForDisconnectedNode(nodeId: string, reason: string): void {
    const broadcaster = (
      this as unknown as {
        __gatewayBroadcaster?: { broadcast: (event: string, payload: unknown) => void };
      }
    ).__gatewayBroadcaster;
    const removed = removeRemoteSessionsForNode(nodeId, {
      reason: "federation-disconnect",
      onAbort: (record) => {
        broadcaster?.broadcast("subagent.complete", {
          runId: record.runId,
          sessionKey: record.sessionKey,
          label: record.label,
          task: record.task,
          endedAt: record.endedAt,
          outcome: {
            status: "aborted",
            reason: "federation-disconnect",
          },
          nodeId,
          disconnectReason: reason,
          ts: record.endedAt ?? Date.now(),
        });
      },
    });

    if (removed.length > 0) {
      log.info("cleaned up remote sessions for disconnected node", {
        nodeId,
        count: removed.length,
        reason,
      });
    }
  }

  /**
   * Get capabilities for a specific node.
   */
  getNodeCapabilities(nodeId: string): NodeCapabilities | null {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    return node.manifest.capabilities;
  }

  /**
   * Get all connected nodes.
   */
  getConnectedNodes(): ConnectedNode[] {
    return [...this.nodes.values()].filter((n) => n.state === "registered");
  }

  /**
   * The id of this master node. Used by federation routing helpers to decide
   * whether an incoming `nodeId` refers to this process (run local) or a peer
   * (forward). See `isLocalNodeId` in local-node.ts.
   */
  getLocalNodeId(): string {
    return this.localNodeId;
  }

  /**
   * Get a specific node by ID.
   */
  getNode(nodeId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Check if a node is connected.
   */
  isNodeConnected(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    return node?.state === "registered";
  }

  /**
   * Send a role.change message to a satellite, promoting it to master.
   * Returns the satellite's advertised URL (hostname:port) for reconnection.
   */
  sendRoleChange(nodeId: string, payload: import("./types.js").RoleChangePayload): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.state !== "registered") return false;
    const msg = buildRoleChangeMessage(this.localNodeId ?? "master", payload);
    void this.sendToNode(nodeId, msg);
    return true;
  }

  // ===========================================================================
  // State Synchronization
  // ===========================================================================

  /**
   * Broadcast a state update to all connected nodes.
   */
  broadcastUpdate(update: Partial<StateUpdate>): void {
    this.stateVersion++;
    const fullUpdate: StateUpdate = {
      version: this.stateVersion,
      nodeId: update.nodeId ?? "master",
      updates: update.updates ?? [],
      timestamp: Date.now(),
    };

    const message = buildStateUpdateMessage(fullUpdate);

    for (const node of this.nodes.values()) {
      if (node.state !== "registered") continue;
      void this.sendToNode(node.id, message);
    }

    this.emit("state:update", fullUpdate);
  }

  /**
   * Broadcast fleet update to all connected satellites.
   * Each satellite will: git pull, build, restart.
   */
  async broadcastFleetUpdate(options?: {
    skipBuild?: boolean;
    branch?: string;
    nodeIds?: string[]; // If specified, only update these nodes
  }): Promise<{
    sent: string[];
    skipped: string[];
    failed: string[];
  }> {
    const sent: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    const targetNodes = options?.nodeIds
      ? [...this.nodes.values()].filter(
          (n) => options.nodeIds!.includes(n.id) || options.nodeIds!.includes(n.manifest.name),
        )
      : [...this.nodes.values()];

    for (const node of targetNodes) {
      if (node.state !== "registered") {
        skipped.push(node.manifest.name);
        continue;
      }

      const message = JSON.stringify({
        type: "system.update",
        payload: {
          skipBuild: options?.skipBuild ?? false,
          branch: options?.branch ?? "main",
        },
        nodeId: this.localNodeId,
        messageId: generateMessageId(),
        timestamp: Date.now(),
      });

      try {
        void this.sendToNode(node.id, message);
        sent.push(node.manifest.name);
        log.info(`[FLEET-UPDATE] Sent update command to ${node.manifest.name}`);
      } catch (err) {
        failed.push(node.manifest.name);
        log.error(`[FLEET-UPDATE] Failed to send to ${node.manifest.name}: ${err}`);
      }
    }

    // Emit event for UI tracking
    this.emit("fleet:update:started", { sent, skipped, failed });

    return { sent, skipped, failed };
  }

  /**
   * Get current state sync payload.
   */
  getStateSyncPayload(): StateSyncPayload {
    const nodes: NodeManifest[] = [
      this.config.localManifest,
      ...this.getConnectedNodes().map((n) => n.manifest),
    ];

    return {
      version: this.stateVersion,
      nodes,
      timestamp: Date.now(),
    };
  }

  // ===========================================================================
  // Compute Routing
  // ===========================================================================

  /**
   * Route a task to the best available node.
   */
  async routeTask(requirements: ComputeRequirements): Promise<{
    nodeId: string;
    reason: string;
    confidence: number;
  }> {
    const task = {
      id: generateNodeId(),
      type: "unknown" as const,
      description: JSON.stringify(requirements),
      workspace: requirements.workspace,
    };
    return await this.router.route(task);
  }

  /**
   * Get compute router instance.
   */
  getRouter(): ComputeRouter {
    return this.router;
  }

  // ===========================================================================
  // Load Balancing
  // ===========================================================================

  /**
   * Get the load balancer instance.
   */
  getLoadBalancer(): FederationLoadBalancer {
    return this.loadBalancer;
  }

  /**
   * Get fleet-wide health summary.
   */
  getFleetHealth(): FleetHealthSummary {
    return this.loadBalancer.getFleetHealth();
  }

  /**
   * Get load metrics for a specific node.
   */
  getNodeMetrics(nodeId: string): NodeLoadMetrics | null {
    return this.loadBalancer.getMetrics(nodeId);
  }

  /**
   * Get all current load metrics.
   */
  getAllNodeMetrics(): NodeLoadMetrics[] {
    return this.loadBalancer.getAllMetrics();
  }

  /**
   * Select the least loaded node for a new session.
   */
  selectLeastLoadedNode(capableNodes?: NodeManifest[]): string | null {
    const nodes = capableNodes ?? [
      this.config.localManifest,
      ...this.getConnectedNodes().map((n) => n.manifest),
    ];
    return this.loadBalancer.selectLeastLoadedNode(nodes);
  }

  // ===========================================================================
  // Session Migration
  // ===========================================================================

  /**
   * Request migration of a session to another node using the new migration orchestrator.
   */
  async requestMigration(request: MigrationRequest): Promise<MigrationResult> {
    log.info(
      `migration requested via orchestrator: ${request.sessionKey} from ${request.sourceNodeId} to ${request.targetNodeId}`,
    );

    try {
      // 1. Verify both nodes are connected before starting migration
      const sourceNode = this.nodes.get(request.sourceNodeId);
      const targetNode =
        request.targetNodeId === this.localNodeId
          ? null // Master is always available
          : this.nodes.get(request.targetNodeId);

      if (
        request.sourceNodeId !== this.localNodeId &&
        (!sourceNode || sourceNode.state !== "registered")
      ) {
        return {
          success: false,
          error: `Source node ${request.sourceNodeId} not connected`,
          durationMs: 0,
        };
      }

      if (
        request.targetNodeId !== this.localNodeId &&
        (!targetNode || targetNode.state !== "registered")
      ) {
        return {
          success: false,
          error: `Target node ${request.targetNodeId} not connected`,
          durationMs: 0,
        };
      }

      // 2. Use the migration orchestrator for the actual migration
      const migrationManager = getMigrationManager();
      const detailedResult = await migrationManager.migrateSession(request, {
        timeoutMs: 5 * 60 * 1000, // 5 minutes
        keepOriginal: false,
        validateState: true,
        maxRetries: 2,
      });

      // 3. Update load balancer tracking
      if (detailedResult.success && detailedResult.newSessionKey) {
        this.loadBalancer.moveSession(
          request.sessionKey,
          request.sourceNodeId,
          request.targetNodeId,
        );
      }

      // 4. Convert detailed result to standard migration result
      const result: MigrationResult = {
        success: detailedResult.success,
        newSessionKey: detailedResult.newSessionKey,
        error: detailedResult.error,
        durationMs: detailedResult.durationMs,
      };

      if (detailedResult.success) {
        log.info(
          `migration completed via orchestrator: ${request.sessionKey} -> ${result.newSessionKey} on ${request.targetNodeId}`,
          {
            duration: result.durationMs,
            stepsCompleted: detailedResult.stepsCompleted,
            transferStats: detailedResult.transferStats,
          },
        );
      } else {
        log.error(`migration failed via orchestrator: ${result.error}`);
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`migration failed: ${error}`);
      return {
        success: false,
        error,
        durationMs: 0,
      };
    }
  }

  /**
   * Request migration with detailed progress tracking.
   * Returns the full DetailedMigrationResult instead of simplified MigrationResult.
   */
  async requestDetailedMigration(request: MigrationRequest): Promise<DetailedMigrationResult> {
    log.info(
      `detailed migration requested: ${request.sessionKey} from ${request.sourceNodeId} to ${request.targetNodeId}`,
    );

    // Verify nodes are connected
    const sourceNode = this.nodes.get(request.sourceNodeId);
    const targetNode =
      request.targetNodeId === this.localNodeId
        ? null // Master is always available
        : this.nodes.get(request.targetNodeId);

    if (
      request.sourceNodeId !== this.localNodeId &&
      (!sourceNode || sourceNode.state !== "registered")
    ) {
      throw new Error(`Source node ${request.sourceNodeId} not connected`);
    }

    if (
      request.targetNodeId !== this.localNodeId &&
      (!targetNode || targetNode.state !== "registered")
    ) {
      throw new Error(`Target node ${request.targetNodeId} not connected`);
    }

    // Use the migration orchestrator
    const migrationManager = getMigrationManager();
    const result = await migrationManager.migrateSession(request, {
      timeoutMs: 5 * 60 * 1000, // 5 minutes
      keepOriginal: false,
      validateState: true,
      maxRetries: 2,
    });

    // Update load balancer tracking
    if (result.success && result.newSessionKey) {
      this.loadBalancer.moveSession(request.sessionKey, request.sourceNodeId, request.targetNodeId);
    }

    return result;
  }

  /**
   * Get session state for migration (conversation history, etc.).
   */
  private async getSessionState(
    nodeId: string,
    sessionKey: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = (await this.invokeOnNode(nodeId, "session.getState", {
        sessionKey,
      })) as unknown as {
        success: boolean;
        state?: Record<string, unknown>;
        error?: string;
      };
      if (response.success && response.state) {
        return response.state;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Create a migrated session on target node.
   */
  private async createMigratedSession(
    nodeId: string,
    sessionState: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const response = (await this.invokeOnNode(nodeId, "session.createMigrated", {
        state: sessionState,
      })) as unknown as {
        success: boolean;
        sessionKey?: string;
        error?: string;
      };
      if (response.success && response.sessionKey) {
        return response.sessionKey;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Cleanup session on source node after successful migration.
   */
  private async cleanupMigratedSession(nodeId: string, sessionKey: string): Promise<void> {
    try {
      await this.invokeOnNode(nodeId, "session.cleanup", { sessionKey, reason: "migrated" });
    } catch (err) {
      log.warn(`failed to cleanup migrated session ${sessionKey} on ${nodeId}: ${err}`);
    }
  }

  /**
   * Get suggested migrations based on current load.
   */
  getSuggestedMigrations(): MigrationRequest[] {
    return this.loadBalancer.suggestMigrations();
  }

  // ===========================================================================
  // Cross-Node Sessions
  // ===========================================================================

  /**
   * Spawn a session on a remote node.
   */
  /**
   * Direct spawn without retry logic - used internally by retry manager
   */
  private async directSpawnRemoteSession(request: SessionSpawnRequest): Promise<SessionHandle> {
    const node = this.nodes.get(request.nodeId);
    if (!node || node.state !== "registered") {
      throw new FederationError(
        FederationErrorCode.NODE_OFFLINE,
        `Node ${request.nodeId} is not connected`,
      );
    }

    // Check permissions for session spawning
    if (!this.checkPermissionAndAudit(request.nodeId, "session.spawn")) {
      this.auditLogger.logSecurityViolation("Unauthorized session spawn attempt", {
        nodeId: request.nodeId,
        operation: "session.spawn",
        workspace: request.workspace,
      });
      throw new FederationError(
        FederationErrorCode.UNAUTHORIZED,
        `Node ${request.nodeId} does not have permission to spawn sessions`,
      );
    }

    // Encrypt sensitive request data if needed
    let processedRequest = request;
    if (this.security.shouldEncryptPayload("session.spawn")) {
      try {
        const encryptedPayload = this.security.encryptPayload(request.nodeId, request);
        processedRequest = { ...request, payload: encryptedPayload } as any;
        log.debug("Encrypted session spawn request", { nodeId: request.nodeId });
      } catch (error) {
        log.error("Failed to encrypt session spawn request", { error });
        // Continue without encryption for backward compatibility
      }
    }

    // Send spawn request to node and wait for response
    // This would integrate with the existing node invoke mechanism
    const response = await this.invokeOnNode(request.nodeId, "session.spawn", processedRequest);

    if (!response.success) {
      this.auditLogger.logSessionOperation(
        "spawn",
        "", // No session key yet
        request.nodeId,
        false,
        { error: response.error, agentId: request.agentId },
      );
      throw new FederationError(
        FederationErrorCode.INTERNAL_ERROR,
        response.error ?? "Failed to spawn session",
      );
    }

    const handle = response.handle!;

    // Ledger: record federated spawn so crash recovery can discover it without runs.json.
    appendSpawnEvent({
      v: 1,
      ts: Date.now(),
      event: "spawn.intent",
      runId: handle.sessionKey,
      kind: "federated",
      task: (request.task ?? "").slice(0, 500),
      label: request.agentId,
      childSessionKey: handle.sessionKey,
      node: request.nodeId,
    });

    // Log successful session spawn
    this.auditLogger.logSessionOperation("spawn", handle.sessionKey, handle.nodeId, true, {
      agentId: request.agentId,
      task: request.task?.substring(0, 100), // Truncate for logging
      workspace: request.workspace,
    });

    // Track the session for failover monitoring
    this.failoverManager.trackSession(
      handle.sessionKey,
      handle.nodeId,
      request,
      "restart", // Default recovery mode - could be configurable per request
    );

    return handle;
  }

  /**
   * Spawn a remote session with automatic retry on failure
   */
  async spawnRemoteSession(request: SessionSpawnRequest): Promise<SessionHandle> {
    // Check if the target node is at capacity
    const node = this.nodes.get(request.nodeId);
    let currentCapacity = 0;

    if (node) {
      // Use current load as capacity indicator
      currentCapacity = node.currentLoad || 0;
    } else if (request.nodeId === this.localNodeId) {
      // For local master node, get metrics from resource monitor
      currentCapacity = this.resourceMonitor?.getLastMetrics()?.loadScore || 0;
    }

    // Update task queue with current capacity
    this.taskQueue.updateNodeCapacity(request.nodeId, currentCapacity);

    // Check if we should queue this request
    if (this.taskQueue.shouldQueue(request.nodeId, currentCapacity)) {
      log.info("Node at capacity, queuing spawn request", {
        nodeId: request.nodeId,
        capacity: currentCapacity,
        agentId: request.agentId,
        task: request.task,
      });

      // Determine priority based on request metadata or default to normal
      const priority: QueuePriority = (request.metadata?.priority as QueuePriority) || "normal";

      // Queue the request
      return this.taskQueue.queueSpawn(request.nodeId, request, priority);
    }

    // Node has capacity, proceed with normal retry logic
    return this.retryManager.executeWithRetry(request);
  }

  /**
   * Get available nodes for retry attempts, optionally excluding certain nodes
   */
  private getAvailableNodes(excludeNodes?: Set<string>): NodeManifest[] {
    const availableNodes: NodeManifest[] = [];

    // Add local master node if not excluded
    if (!excludeNodes?.has(this.localNodeId)) {
      availableNodes.push(this.config.localManifest);
    }

    // Add connected satellite nodes that are not excluded
    for (const node of this.nodes.values()) {
      if (node.state === "registered" && !excludeNodes?.has(node.id)) {
        availableNodes.push(node.manifest);
      }
    }

    return availableNodes;
  }

  /**
   * Send a message to a session on a remote node.
   */
  async sendRemoteMessage(
    request: SessionSendRequest,
  ): Promise<{ success: boolean; reply?: string; error?: string }> {
    const node = this.nodes.get(request.nodeId);
    if (!node || node.state !== "registered") {
      return {
        success: false,
        error: `Node ${request.nodeId} is not connected`,
      };
    }

    const response = await this.invokeOnNode(request.nodeId, "session.send", request);
    return {
      success: response.success,
      reply: response.reply,
      error: response.error,
    };
  }

  /**
   * Spawn a session with capability-based routing.
   * Routes the request to the best node based on required capabilities.
   */
  async spawnWithCapabilityRouting(request: SessionSpawnRequest): Promise<SessionHandle> {
    // Check if capability requirements are specified
    if (request.requiredCapabilities && request.requiredCapabilities.length > 0) {
      const availableNodes = this.getAvailableNodes();

      if (availableNodes.length === 0) {
        throw new FederationError(
          FederationErrorCode.NODE_NOT_FOUND,
          "No nodes available for capability routing",
        );
      }

      // Parse capability requirements
      const capabilities = parseCapabilityRequirements({
        requiredCapabilities: request.requiredCapabilities,
        preferredCapabilities: request.preferredCapabilities,
        minGpuVRAM: request.minGpuVRAM,
        workspace: request.workspace,
        preferNode: request.nodeId !== this.localNodeId ? request.nodeId : undefined,
      });

      // Route using capability scoring
      const routingDecision = await routeByCapabilities(availableNodes, capabilities);

      log.info("capability-based spawn routing", {
        originalNode: request.nodeId,
        selectedNode: routingDecision.nodeId,
        confidence: routingDecision.confidence,
        reason: routingDecision.reason,
        requiredCapabilities: request.requiredCapabilities,
      });

      // Update the request with the selected node
      const routedRequest: SessionSpawnRequest = {
        ...request,
        nodeId: routingDecision.nodeId,
      };

      return this.spawnRemoteSession(routedRequest);
    } else {
      // No capabilities specified, use normal routing
      return this.spawnRemoteSession(request);
    }
  }

  // ===========================================================================
  // Task Queue Management
  // ===========================================================================

  /**
   * Get current queue statistics across all nodes.
   */
  getQueueStats(): QueueStats {
    return this.taskQueue.getStats();
  }

  /**
   * Get queue status for all nodes (items count, capacity, threshold).
   */
  getQueueStatus(): Record<string, { totalItems: number; capacity: number; threshold: number }> {
    return this.taskQueue.getQueueStatus();
  }

  /**
   * Get queue position for a specific task.
   */
  getQueuePosition(
    itemId: string,
  ): { nodeId: string; position: number; totalInQueue: number } | null {
    return this.taskQueue.getQueuePosition(itemId);
  }

  /**
   * Manually notify that a node has capacity available.
   * This can be used to trigger queue processing when capacity becomes available.
   */
  notifyNodeCapacityAvailable(nodeId: string): void {
    this.taskQueue.notifyCapacityAvailable(nodeId);
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Handle new WebSocket connection.
   */
  private handleConnection(socket: WebSocket, request: http.IncomingMessage): void {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    log.debug(`new connection from ${remoteAddress}`);

    socket.on("message", (data) => {
      this.handleMessage(socket, data).catch((error) => {
        log.error("Failed to handle message", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    socket.on("close", (code, reason) => {
      const nodeId = this.socketToNode.get(socket);
      if (nodeId) {
        const reasonStr = reason?.toString() || `code ${code}`;
        this.disconnectNode(nodeId, reasonStr);
      }
    });

    socket.on("error", (error) => {
      const nodeId = this.socketToNode.get(socket);
      log.error(`socket error${nodeId ? ` (node ${nodeId})` : ""}: ${error.message}`);
    });
  }

  /**
   * Handle incoming message from a satellite.
   */
  private async handleMessage(socket: WebSocket, data: unknown): Promise<void> {
    const str = typeof data === "string" ? data : (data as Buffer).toString("utf-8");

    // DEBUG: Log raw incoming message
    log.info(`[HUB-RAW] Message received (${str.length} bytes): ${str.substring(0, 200)}`);
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(
        "C:\\tmp\\hub-raw-debug.log",
        `${new Date().toISOString()} [RAW] ${str.substring(0, 500)}\n`,
      );
    } catch (e) {
      log.warn(`[HUB-RAW] File write failed: ${e}`);
    }

    // DEBUG: Log that we're entering the try block
    try {
      const fs = require("node:fs");
      fs.appendFileSync(
        "C:\\tmp\\hub-try-block.log",
        `${new Date().toISOString()} ENTERING TRY BLOCK, optimizer exists: ${!!this.messageOptimizer}\n`,
      );
    } catch {
      /* ignore */
    }

    try {
      // First, process through message optimizer to handle batched/compressed messages
      let processedMessages: string[];
      try {
        processedMessages = await this.messageOptimizer.processReceived(str);
      } catch (optimizerErr) {
        // Optimizer failed - process raw message directly
        const fs = require("node:fs");
        fs.appendFileSync(
          "C:\\tmp\\hub-optimizer-error.log",
          `${new Date().toISOString()} Optimizer error: ${optimizerErr}, processing raw: ${str.substring(0, 200)}\n`,
        );
        processedMessages = [str];
      }

      // DEBUG: Log processed messages
      try {
        const fs = require("node:fs");
        fs.appendFileSync(
          "C:\\tmp\\hub-processed-debug.log",
          `${new Date().toISOString()} processedMessages count: ${processedMessages.length}\n`,
        );
        for (const msg of processedMessages) {
          fs.appendFileSync(
            "C:\\tmp\\hub-processed-debug.log",
            `${new Date().toISOString()} PROCESSED: ${msg.substring(0, 300)}\n`,
          );
        }
      } catch {
        /* ignore */
      }

      // Handle each message in the processed array
      for (const messageStr of processedMessages) {
        await this.handleSingleMessage(socket, messageStr);
      }
    } catch (err) {
      log.error(`failed to process message: ${err instanceof Error ? err.message : String(err)}`);
      this.sendError(socket, FederationErrorCode.INVALID_MESSAGE, "Invalid message format");
    }
  }

  /**
   * Handle a single federation message.
   */
  private async handleSingleMessage(socket: WebSocket, messageStr: string): Promise<void> {
    let message: FederationMessage;

    // DEBUG: Log all incoming messages to file
    const debugLog = (msg: string) => {
      try {
        const { appendFileSync } = require("node:fs");
        appendFileSync("C:\\tmp\\hub-spawn-debug.log", `${new Date().toISOString()} ${msg}\n`);
      } catch {
        /* ignore */
      }
    };
    debugLog(`[HUB-MSG] Raw: ${messageStr.substring(0, 300)}`);

    try {
      message = deserializeMessage(messageStr);
    } catch (err) {
      log.error(`invalid message: ${err instanceof Error ? err.message : String(err)}`);
      debugLog(
        `[HUB-MSG] Deserialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.sendError(socket, FederationErrorCode.INVALID_MESSAGE, "Invalid message format");
      return;
    }

    debugLog(
      `[HUB-MSG] Parsed type: ${message.type}, messageId: ${message.messageId}, correlationId: ${(message as any).correlationId}`,
    );

    if (!isValidMessageType(message.type)) {
      log.warn(`unknown message type: ${message.type}`);
      debugLog(`[HUB-MSG] Unknown type rejected: ${message.type}`);
      this.sendError(
        socket,
        FederationErrorCode.INVALID_MESSAGE,
        `Unknown message type: ${message.type}`,
      );
      return;
    }

    const nodeId = this.socketToNode.get(socket);

    // Handle delivery guarantees for guaranteed message types
    if (
      message.messageId &&
      nodeId &&
      (message.type === "session.spawn" ||
        message.type === "session.complete" ||
        message.type === "identity.sync" ||
        message.type === "mcp.invoke")
    ) {
      // Check for duplicates
      if (this.deliveryManager.isDuplicate(message.messageId, nodeId)) {
        log.debug("Dropping duplicate message", {
          messageId: message.messageId,
          type: message.type,
          nodeId,
        });
        // Still send ACK for duplicates to prevent retries
        const ack = buildDeliveryAckMessage(message.messageId, this.localNodeId);
        socket.send(ack);
        return;
      }

      // Send ACK for guaranteed messages
      const ack = buildDeliveryAckMessage(message.messageId, this.localNodeId);
      socket.send(ack);

      log.debug("Sent delivery ACK", {
        messageId: message.messageId,
        type: message.type,
        nodeId,
      });
    }

    // Handle registration (unauthenticated)
    if (isMessageType(message, "node.register")) {
      this.handleRegister(socket, message);
      return;
    }

    // All other messages require registration
    if (!nodeId) {
      this.sendError(socket, FederationErrorCode.UNAUTHORIZED, "Node not registered");
      return;
    }

    // Route to specific handler
    switch (message.type) {
      case "node.heartbeat":
        this.handleHeartbeat(nodeId, message);
        break;
      case "node.capabilities":
        this.handleCapabilitiesUpdate(nodeId, message);
        break;
      case "node.disconnect":
        this.handleDisconnect(nodeId, message);
        break;
      case "session.spawn.result":
      case "session.send.result":
        this.handleSessionResult(nodeId, message);
        break;
      case "gateway.proxy.invoke.result":
        this.handleGatewayProxyResult(nodeId, message);
        break;
      case "gateway.proxy.invoke.stream":
        this.handleGatewayProxyStreamChunk(nodeId, message);
        break;
      case "gateway.proxy.invoke.stream.cancel":
        // Master-initiated cancel sent to satellite; handled by satellite.
        // Arriving here means a satellite forwarded it to master (unlikely
        // but harmless to log).
        log.debug(
          `gateway.proxy.invoke.stream.cancel from ${nodeId} (unexpected — master-initiated)`,
        );
        break;
      case "event.broadcast":
        this.handleSatelliteEventBroadcast(nodeId, message);
        break;
      case "session.complete":
        void this.handleSessionComplete(nodeId, message);
        break;
      case "compute.route":
        void this.handleComputeRoute(nodeId, message);
        break;
      case "state.sync":
        this.handleStateSync(nodeId, message);
        break;
      case "state.sync.push":
      case "state.sync.pull":
      case "state.sync.ack":
      case "state.sync.full":
        this.handleStateSyncMessage(nodeId, message);
        break;
      case "mcp.list":
        this.handleMCPList(nodeId, message);
        break;
      case "mcp.invoke":
        void this.handleMCPInvoke(nodeId, message);
        break;
      case "mcp.invoke.result":
        this.handleMCPInvokeResult(nodeId, message);
        break;
      case "federation.event":
        this.handleFederationEvent(nodeId, message);
        break;
      case "memory.update":
        void this.handleMemoryUpdate(nodeId, message);
        break;
      case "delivery.ack":
        this.handleDeliveryAck(nodeId, message);
        break;
      case "transcript.request":
        this.handleTranscriptRequest(nodeId, message);
        break;
      case "transcript.response":
        this.handleTranscriptResponse(nodeId, message);
        break;
      case "transcript.stream":
        this.handleTranscriptStream(nodeId, message);
        break;
      case "peer.discovery":
        this.handlePeerDiscovery(nodeId, message);
        break;
      case "identity.sync.request":
        this.handleIdentitySyncRequest(nodeId);
        break;
      case "master.gateway.invoke":
        void this.handleMasterGatewayInvoke(nodeId, message);
        break;
      case "hardware.snapshot":
        this.handleHardwareSnapshot(nodeId, message);
        break;
      case "file-transfer.start":
      case "file-transfer.chunk":
      case "file-transfer.chunk.ack":
      case "file-transfer.complete":
      case "file-transfer.error":
      case "file-transfer.pause":
      case "file-transfer.resume":
        this.handleFileTransferMessage(nodeId, message);
        break;
      default:
        log.debug(`unhandled message type: ${message.type}`);
    }
  }

  /**
   * Handle a satellite's `hardware.snapshot` push — payload is a
   * HardwareSnapshot. We cache the latest per-node snapshot for the UI to
   * read via /api/hardware/nodes. No fan-out, no history.
   */
  private handleHardwareSnapshot(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as HardwareSnapshotPayload | undefined;
    if (!payload || typeof payload !== "object" || typeof payload.timestamp !== "number") {
      return;
    }
    this.satelliteHardware.set(nodeId, {
      snapshot: payload,
      receivedAt: Date.now(),
    });
  }

  /**
   * Most recent HardwareSnapshot pushed by a satellite node, if any.
   * Used by the master's /api/hardware/nodes endpoint.
   */
  getSatelliteHardware(
    nodeId: string,
  ): { snapshot: HardwareSnapshotPayload; receivedAt: number } | null {
    return this.satelliteHardware.get(nodeId) ?? null;
  }

  /**
   * Handle a satellite's `master.gateway.invoke` — the satellite is proxying
   * an RPC (e.g. business.create, business.income.log) up to the master so
   * the master's gateway can apply the write against its authoritative state.
   *
   * Dispatches against the master's coreGatewayHandlers and replies with a
   * `master.gateway.invoke.result` carrying the response. The correlationId
   * round-trips so the satellite can match the reply to the pending promise.
   */
  private async handleMasterGatewayInvoke(
    nodeId: string,
    message: FederationMessage,
  ): Promise<void> {
    const correlationId =
      (message as { correlationId?: string }).correlationId ??
      (message as { messageId?: string }).messageId ??
      "";
    const node = this.nodes.get(nodeId);
    if (!node) {
      log.warn(`master.gateway.invoke from unknown node ${nodeId}`);
      return;
    }
    const payload =
      typeof message.payload === "object" && message.payload !== null
        ? (message.payload as Record<string, unknown>)
        : {};
    const method = typeof payload.method === "string" ? payload.method : "";
    const params =
      payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
        ? (payload.params as Record<string, unknown>)
        : {};

    const reply = (body: {
      success: boolean;
      data?: unknown;
      error?: { code?: string; message?: string };
    }) => {
      try {
        node.socket.send(
          JSON.stringify({
            type: "master.gateway.invoke.result",
            payload: body,
            nodeId: this.localNodeId,
            timestamp: Date.now(),
            correlationId,
          }),
        );
      } catch (err) {
        log.warn(
          `master.gateway.invoke.result send to ${nodeId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    if (!method) {
      reply({ success: false, error: { code: "INVALID_REQUEST", message: "method required" } });
      return;
    }
    // A satellite may only remove ITSELF ("Leave"), never another device.
    if (method === "federation.devices.remove") {
      params.id = nodeId;
      params.nodeId = nodeId;
    }

    try {
      const { coreGatewayHandlers } = await import("../gateway/server-methods.js");
      // Satellites proxy some prefixes (business., leads., funnels., …) that a
      // first-party plugin serves on master (legacy aliases included).
      const { getPluginGatewayHandlers } = await import("../plugins/runtime.js");
      const handler =
        (coreGatewayHandlers as Record<string, ((opts: unknown) => Promise<void>) | undefined>)[
          method
        ] ??
        (
          getPluginGatewayHandlers() as Record<
            string,
            ((opts: unknown) => Promise<void>) | undefined
          >
        )[method];
      if (!handler) {
        reply({
          success: false,
          error: { code: "UNKNOWN_METHOD", message: `master has no handler for ${method}` },
        });
        return;
      }
      // Wrap the standard gateway-handler `respond` callback so the
      // success/error/data shape lands in our reply payload. The handler
      // contract gives us either (true, data) or (false, undefined, error).
      await handler({
        req: { id: correlationId, method, params },
        params,
        respond: (
          success: boolean,
          data?: unknown,
          error?: { code?: string; message?: string },
        ) => {
          // If the handler returned a sessionKey/runId, remember which
          // satellite asked for this run so subsequent gateway broadcast
          // events (agent text deltas, tool calls, completion, terminal
          // output) can be forwarded back to it via event.forward. This
          // is what makes "thinking…" actually progress on the
          // satellite's UI.
          if (success && data && typeof data === "object") {
            const d = data as {
              runId?: string;
              sessionKey?: string;
              childSessionKey?: string;
              terminalId?: string;
              id?: string;
            };
            const tagged: string[] = [];
            if (typeof d.runId === "string" && d.runId) {
              this.tunneledRunOwners.set(d.runId, nodeId);
              tagged.push(`runId=${d.runId}`);
            }
            const sk = typeof d.sessionKey === "string" ? d.sessionKey : d.childSessionKey;
            if (typeof sk === "string" && sk) {
              this.tunneledSessionOwners.set(sk, nodeId);
              tagged.push(`sessionKey=${sk}`);
            }
            // Terminal methods return either `terminalId` (spawnAgent) or
            // `id` (terminal.create). Both register so terminal.output /
            // terminal.created / terminal.exit broadcast from this PTY
            // get forwarded back to the originating satellite's xterm.
            const tid =
              typeof d.terminalId === "string" && d.terminalId
                ? d.terminalId
                : typeof d.id === "string" && d.id && method.startsWith("terminal.")
                  ? d.id
                  : "";
            if (tid) {
              this.tunneledTerminalOwners.set(tid, nodeId);
              tagged.push(`terminalId=${tid}`);
            }
            if (tagged.length > 0) {
              log.info(
                `[FED-RELAY] registered tunneled run for ${nodeId} method=${method} ${tagged.join(" ")}`,
              );
            } else {
              log.debug(
                `[FED-RELAY] dispatched ${method} for ${nodeId} but no runId/sessionKey/terminalId in result — events won't be forwarded`,
              );
            }
          }
          reply({ success, data, error });
        },
        // Provide as much gateway context as the hub has access to.
        // Tunneled handlers can access: dedupe map (idempotency), the
        // model catalog loader (chat.history uses this when resolving
        // thinking defaults), and the gateway broadcaster (in case
        // handlers want to emit events that should reach UI clients
        // connected to the master).
        //
        // Other context fields (chat run state, client identity, etc.)
        // are still undefined — most handlers that need them are local-
        // run-specific and shouldn't be exposed through the federation
        // tunnel anyway. handlers that read missing fields can either
        // short-circuit or fail with a clear error visible in the
        // event.forward chain.
        context: await this.buildTunneledHandlerContext(),
      } as unknown as Parameters<typeof handler>[0]);
    } catch (err) {
      reply({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /**
   * Handle node registration with security validation.
   */
  private handleRegister(socket: WebSocket, message: FederationMessage): void {
    const payload = message.payload;

    if (!validateNodeRegisterPayload(payload)) {
      this.auditLogger.logFailure("node.register", "Invalid registration payload");
      this.sendError(socket, FederationErrorCode.SCHEMA_ERROR, "Invalid registration payload");
      return;
    }

    // Check protocol version
    const compat = getProtocolCompatibility(payload.protocolVersion);
    if (!compat.compatible) {
      this.auditLogger.logFailure("node.register", compat.message);
      this.sendError(socket, FederationErrorCode.PROTOCOL_MISMATCH, compat.message);
      socket.close(1002, compat.message);
      return;
    }

    // Whether the federation requires satellites to authenticate with a token.
    // Default TRUE: a tokenless node would otherwise get "full" permission
    // (session spawn, MCP invoke, identity sync incl. the gateway password).
    // Invite-joined satellites carry a signed token and are unaffected; legacy
    // tokenless satellites need `federation.requireRegisterToken: false`.
    const requireRegisterToken = loadConfig().federation?.requireRegisterToken;
    const securityEnabled = requireRegisterToken !== false;
    // The register-ack security payload stays opt-in (explicit true) so the
    // ack shape is unchanged for existing token-bearing satellites.
    const attachAckSecurity = requireRegisterToken === true;

    // Extract security token if provided
    const token = (payload as any).token as SatelliteToken | undefined;
    let permissionLevel: PermissionLevel = "full"; // Default for backward compatibility

    // Durable per-device credential handed back on a first (invite) join.
    let deviceCredential: SatelliteToken | undefined;
    if (token) {
      // Validate token
      const rejection = this.security.diagnoseSatelliteToken(token);
      const permissions = rejection ? null : this.security.validateSatelliteToken(token);
      if (!permissions) {
        this.auditLogger.logSecurityViolation("Invalid satellite token", {
          satelliteId: token.satelliteId,
          nodeId: payload.manifest.id,
          errorCode: rejection?.code ?? "invalid",
          metadata: { fingerprint: tokenFingerprint(token) },
        });
        this.sendError(
          socket,
          FederationErrorCode.UNAUTHORIZED,
          rejection?.message ?? "Invalid authentication token",
        );
        socket.close(1008, `Authentication failed: ${rejection?.code ?? "invalid"}`);
        return;
      }
      permissionLevel = permissions.level;
      // The node id a satellite registers under can differ from the token's
      // satelliteId — grant the permissions to both so permission checks
      // (session.spawn, mcp.invoke) find them.
      this.security.grantPermissions(payload.manifest.id, permissions);
      // An invite is short-lived (expiresAt). Swap it for a durable credential
      // bound to the same satelliteId so reconnects after the invite window
      // (sleep, reboot, network change) keep working.
      if (token.expiresAt) {
        deviceCredential = this.security.createSatelliteToken(token.satelliteId, permissions);
      }
      try {
        upsertPairedDevice({
          satelliteId: token.satelliteId,
          nodeId: payload.manifest.id,
          name: payload.manifest.name,
          hostname: payload.manifest.hostname,
          platform: payload.manifest.capabilities?.platform,
          lastSeenAt: Date.now(),
          revokedAt: null,
        });
      } catch (err) {
        log.warn(
          `could not record paired device: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (securityEnabled) {
      // Config-gated token requirement: reject tokenless registrations when
      // `federation.requireRegisterToken` is enabled.
      this.auditLogger.logSecurityViolation("Registration token required", {
        nodeId: payload.manifest.id,
      });
      this.sendError(
        socket,
        FederationErrorCode.UNAUTHORIZED,
        "Federation requires a valid registration token. Join with an invite from the master (Fleet › Share Invite).",
      );
      socket.close(1008, "Authentication required");
      return;
    } else {
      // Permissive default: nodes without tokens get default permissions.
      log.warn(`Node registering without security token: ${payload.manifest.id}`);
      const defaultPermissions = DEFAULT_PERMISSIONS[permissionLevel];
      this.security.createSatelliteToken(payload.manifest.id, defaultPermissions);
    }

    // Establish encryption session
    let encryptionSession;
    if ((payload as any).publicKey) {
      try {
        encryptionSession = this.security.establishEncryptionSession(
          payload.manifest.id,
          (payload as any).publicKey,
        );

        this.auditLogger.logEncryptionEstablishment(
          payload.manifest.id,
          encryptionSession.sessionId,
          true,
        );
      } catch (error) {
        this.auditLogger.logEncryptionEstablishment(
          payload.manifest.id,
          "",
          false,
          error instanceof Error ? error.message : "Unknown error",
        );
        log.warn("Failed to establish encryption session", { error });
      }
    }

    // Register the node
    const node = this.registerNode(payload.manifest, socket);

    // Log successful registration
    this.auditLogger.logNodeRegistration(node.id, payload.manifest.id, permissionLevel, true);

    // Build the register-ack. When federation security is enabled, attach a
    // security payload (server-issued session token, hub public-key
    // fingerprint, and the granted capability scopes). Omitted otherwise so
    // the ack shape is unchanged for permissive deployments.
    let securityPayload: RegisterAckSecurityPayload | undefined;
    if (attachAckSecurity) {
      const permissions =
        this.security.getPermissions(payload.manifest.id) ?? DEFAULT_PERMISSIONS[permissionLevel];
      // Issue a fresh, signed session token (24h) for subsequent requests.
      const sessionToken = this.security.createSatelliteToken(payload.manifest.id, permissions, 24);
      securityPayload = {
        sessionToken,
        publicKeyFingerprint: this.security.getHubPublicKeyFingerprint(),
        scopes: permissions.allowedOperations,
      };
    }

    if (deviceCredential) {
      securityPayload = {
        ...(securityPayload ?? {
          scopes: this.security.getPermissions(node.id)?.allowedOperations ?? [],
        }),
        credential: deviceCredential,
        publicKeyFingerprint: this.security.getHubPublicKeyFingerprint(),
      };
    }

    const ack = buildRegisterAckMessage(true, node.id, undefined, securityPayload);
    socket.send(ack);

    // Send current state sync
    const stateSync = buildStateSyncAckMessage(this.getStateSyncPayload());
    socket.send(stateSync);
  }

  /**
   * Check if node has permission for operation and log the check
   */
  private checkPermissionAndAudit(nodeId: string, operation: OperationType): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      this.auditLogger.logPermissionCheck(nodeId, operation, false, undefined, "Node not found");
      return false;
    }

    const hasPermission = this.security.checkPermission(nodeId, operation);
    const permissions = this.security.getPermissions(nodeId);

    this.auditLogger.logPermissionCheck(
      nodeId,
      operation,
      hasPermission,
      permissions?.level,
      hasPermission ? undefined : "Permission denied",
    );

    return hasPermission;
  }

  /**
   * Handle encrypted payload if needed
   */
  private handleEncryptedPayload(nodeId: string, message: FederationMessage): any {
    if (message.payload && typeof message.payload === "object" && "encrypted" in message.payload) {
      try {
        const decrypted = this.security.decryptPayload(nodeId, message.payload as any);
        log.debug("Decrypted payload", { nodeId, messageType: message.type });
        return decrypted;
      } catch (error) {
        log.error("Failed to decrypt payload", { error, nodeId, messageType: message.type });
        this.auditLogger.logFailure(
          "encryption.error",
          error instanceof Error ? error : "Decryption failed",
          {
            nodeId,
            operation: message.type,
          },
        );
        return null;
      }
    }
    return message.payload;
  }

  /**
   * Handle heartbeat from node.
   */
  private handleHeartbeat(nodeId: string, message: FederationMessage): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const payload = message.payload as {
      timestamp: number;
      load?: number;
      activeSessions?: number;
      // Extended metrics from load-aware satellites
      metrics?: Partial<NodeLoadMetrics>;
    };

    node.lastHeartbeat = Date.now();
    if (typeof payload.load === "number") {
      node.currentLoad = payload.load;
    }
    if (typeof payload.activeSessions === "number") {
      node.activeSessions = payload.activeSessions;
    }

    // Record successful heartbeat in health tracker
    this.healthTracker.recordHeartbeat(nodeId, true);

    // Update router
    this.router.updateNodeStatus(nodeId, {
      currentLoad: node.currentLoad,
      activeSessions: node.activeSessions,
      lastSeenMs: node.lastHeartbeat,
    });

    // Update task queue with new capacity
    if (typeof payload.load === "number") {
      this.taskQueue.updateNodeCapacity(nodeId, payload.load);
    }

    // Update load balancer and router with full metrics if provided
    if (payload.metrics) {
      const fullMetrics: NodeLoadMetrics = {
        ...payload.metrics,
        nodeId,
        timestamp: node.lastHeartbeat,
        activeSessions: node.activeSessions,
        loadScore: payload.load || payload.metrics.loadScore || 0,
      } as NodeLoadMetrics;

      this.loadBalancer.updateMetrics(nodeId, fullMetrics);
      this.router.updateNodeMetrics(nodeId, fullMetrics);
      updateCapabilityRouterMetrics(nodeId, fullMetrics);
    } else {
      // Basic metrics update from legacy heartbeat
      const basicMetrics: NodeLoadMetrics = {
        nodeId,
        timestamp: node.lastHeartbeat,
        loadScore: node.currentLoad || 0,
        activeSessions: node.activeSessions || 0,
        cpuPercent: node.currentLoad || 0, // Approximate
        memoryPercent: 0,
        pendingTasks: 0,
      };

      this.loadBalancer.updateMetrics(nodeId, basicMetrics);
      this.router.updateNodeMetrics(nodeId, basicMetrics);
      updateCapabilityRouterMetrics(nodeId, basicMetrics);
    }

    // Send ack
    const ack = buildHeartbeatAckMessage(payload.timestamp);
    void this.sendToNode(nodeId, ack);

    this.emit("node:heartbeat", nodeId, node.currentLoad, node.activeSessions);
  }

  /**
   * Handle capabilities update.
   */
  private handleCapabilitiesUpdate(nodeId: string, message: FederationMessage): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const payload = message.payload as { capabilities: NodeCapabilities };
    node.manifest.capabilities = payload.capabilities;

    // Re-register with router to update capabilities
    this.router.registerNode(node.manifest);

    log.info(`node ${nodeId} updated capabilities`);
  }

  /**
   * Handle graceful disconnect.
   */
  private handleDisconnect(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as { reason: string; reconnect: boolean };
    this.disconnectNode(nodeId, payload.reason);
  }

  /**
   * Handle session spawn/send results.
   */
  private handleSessionResult(nodeId: string, message: FederationMessage): void {
    // DEBUG: Log to file
    try {
      const fs = require("node:fs");
      fs.appendFileSync(
        "C:\\tmp\\hub-result-debug.log",
        `${new Date().toISOString()} handleSessionResult called: ${JSON.stringify(message).substring(0, 500)}\n`,
      );
    } catch {
      /* ignore */
    }

    const payload = message.payload as {
      messageId?: string;
      requestId?: string;
      correlationId?: string;
      success?: boolean;
      sessionKey?: string;
      runId?: string;
      error?: string;
      reply?: string;
    };

    // Get the request ID from the response (check multiple fields for compatibility)
    // correlationId can be at message level (preferred) or in payload
    const messageCorrelationId = (message as unknown as { correlationId?: string }).correlationId;
    const requestId =
      payload.messageId ||
      payload.requestId ||
      messageCorrelationId ||
      payload.correlationId ||
      message.messageId;

    // DEBUG: Log pending requests
    try {
      const fs = require("node:fs");
      const pendingKeys = Array.from(this.pendingRequests.keys());
      fs.appendFileSync(
        "C:\\tmp\\hub-result-debug.log",
        `${new Date().toISOString()} Looking for requestId: ${requestId}, pending: [${pendingKeys.join(", ")}]\n`,
      );
    } catch {
      /* ignore */
    }

    log.info(`[HUB] Received session result from ${nodeId}`, {
      type: message.type,
      success: payload.success,
      sessionKey: payload.sessionKey,
      runId: payload.runId,
      error: payload.error,
      requestId,
      messageCorrelationId,
      messageMessageId: message.messageId,
      hasPendingRequest: requestId ? this.pendingRequests.has(requestId) : false,
    });

    if (requestId) {
      // Resolve the pending request
      this.handleInvokeResponse(
        requestId,
        {
          success: payload.success ?? true,
          sessionKey: payload.sessionKey,
          runId: payload.runId,
          error: payload.error,
          reply: payload.reply,
          handle: payload.sessionKey
            ? {
                nodeId,
                sessionKey: payload.sessionKey,
                runId: payload.runId || requestId,
              }
            : undefined,
        },
        nodeId,
      );
    } else {
      log.warn(
        `[HUB] Session result from ${nodeId} without requestId - cannot resolve pending request`,
        {
          type: message.type,
          payload,
          messageKeys: Object.keys(message),
        },
      );
    }
  }

  /**
   * Resolve a pending generic gateway-proxy invoke. Mirrors the session
   * result path but the payload shape is `{ success, payload, error }` so
   * the caller can inspect arbitrary RPC responses (terminal.create's id,
   * terminal.getBuffer's bytes, etc.).
   */
  private handleGatewayProxyResult(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      success?: boolean;
      payload?: unknown;
      error?: string;
    };
    const messageCorrelationId = (message as unknown as { correlationId?: string }).correlationId;
    const requestId = messageCorrelationId || message.messageId;
    if (!requestId) {
      log.warn(`[HUB] gateway.proxy.invoke.result from ${nodeId} without correlationId`);
      return;
    }
    // Stash the payload on the result so the federation.node.invoke handler
    // can pick it up. handleInvokeResponse only knows the SessionResult
    // shape — we encode the proxy payload in `reply` (string) by JSON.
    const reply = payload.payload === undefined ? undefined : JSON.stringify(payload.payload);
    this.handleInvokeResponse(
      requestId,
      {
        success: payload.success ?? true,
        reply,
        error: payload.error,
      },
      nodeId,
    );
  }

  /**
   * Handle an incoming stream chunk from a satellite for a streamed
   * gateway proxy invoke. Route it to the active stream listener registered
   * in hub-forward.ts.
   */
  private handleGatewayProxyStreamChunk(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      correlationId?: string;
      index?: number;
      payload?: unknown;
      done?: boolean;
      error?: string;
    };
    const correlationId =
      (message as unknown as { correlationId?: string }).correlationId ?? payload.correlationId;

    if (!correlationId) {
      log.warn("gateway.proxy.invoke.stream missing correlationId", { nodeId });
      return;
    }

    if (payload.error) {
      const handled = pushStreamError(correlationId, new Error(payload.error));
      if (!handled) {
        log.warn("gateway.proxy.invoke.stream error with no active listener", {
          nodeId,
          correlationId,
          error: payload.error,
        });
      }
      return;
    }

    const chunk: StreamChunk = {
      index: typeof payload.index === "number" ? payload.index : 0,
      payload: payload.payload,
      done: payload.done === true,
    };

    const handled = pushStreamChunk(correlationId, chunk);
    if (!handled) {
      log.warn("gateway.proxy.invoke.stream chunk with no active listener", {
        nodeId,
        correlationId,
        index: chunk.index,
      });
    }
  }

  /**
   * Handle a satellite forwarding a local broadcaster event up to us.
   * Re-broadcast on the master's gateway with the originating nodeId injected
   * into the payload so master UI clients can route to the right panel.
   */
  private handleSatelliteEventBroadcast(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as { event?: string; payload?: unknown } | null;
    if (!payload || typeof payload.event !== "string") return;
    const broadcaster = (
      this as unknown as {
        __gatewayBroadcaster?: { broadcast: (event: string, payload: unknown) => void };
      }
    ).__gatewayBroadcaster;
    if (!broadcaster) return;
    const tagged =
      typeof payload.payload === "object" && payload.payload !== null
        ? { ...(payload.payload as Record<string, unknown>), federationNodeId: nodeId }
        : { value: payload.payload, federationNodeId: nodeId };
    try {
      broadcaster.broadcast(payload.event, tagged);
    } catch (err) {
      log.warn(
        `event.broadcast re-emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build the context object passed to gateway handlers when dispatched
   * via handleMasterGatewayInvoke (tunneled satellite calls). Wires up
   * the small set of context fields satellite-tunneled handlers
   * actually use:
   *   - dedupe: per-hub idempotency map (agent retries, etc.)
   *   - loadGatewayModelCatalog: chat.history uses this when computing
   *     the thinking default for a session
   *   - broadcast: optional, lets a handler emit events that reach
   *     master's local UI clients AND get forwarded back to the
   *     originating satellite via maybeForwardEvent
   *
   * Keeps the surface minimal — anything not listed is undefined and
   * handlers must tolerate that.
   */
  private async buildTunneledHandlerContext(): Promise<Record<string, unknown>> {
    pruneTunneledDedupe(this.tunneledHandlerDedupe);
    const ctx: Record<string, unknown> = { dedupe: this.tunneledHandlerDedupe };
    try {
      const { loadGatewayModelCatalog } = await import("../gateway/server-model-catalog.js");
      ctx.loadGatewayModelCatalog = loadGatewayModelCatalog;
    } catch (err) {
      log.debug(
        `tunneled context: loadGatewayModelCatalog unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const broadcaster = (
      this as unknown as {
        __gatewayBroadcaster?: { broadcast: (event: string, payload: unknown) => void };
      }
    ).__gatewayBroadcaster;
    if (broadcaster) {
      ctx.broadcast = broadcaster.broadcast;
    }
    return ctx;
  }

  /**
   * Forward a master-side gateway broadcast event back to a satellite
   * that originated the underlying run via master.gateway.invoke. Called
   * by the gateway's broadcaster wrapper (see server.impl.ts) for every
   * outbound event. Looks up the originating satellite by runId or
   * sessionKey, and if matched, sends an event.forward frame so the
   * satellite re-broadcasts on its local WS.
   *
   * Cheap on the hot path: a Map.get + early return when the event
   * carries no tunneled identifiers. Cleans up the registry when the
   * event signals run completion to keep the registry bounded.
   *
   * Public so the gateway runtime can call it. Idempotent + safe to call
   * with arbitrary event payloads.
   */
  maybeForwardEvent(event: string, payload: unknown): void {
    if (
      this.tunneledRunOwners.size === 0 &&
      this.tunneledSessionOwners.size === 0 &&
      this.tunneledTerminalOwners.size === 0
    ) {
      return; // No tunneled runs in flight — fast path.
    }
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as {
      runId?: unknown;
      sessionKey?: unknown;
      childSessionKey?: unknown;
      terminalId?: unknown;
      id?: unknown;
    };
    const runId = typeof p.runId === "string" ? p.runId : null;
    const sessionKey =
      typeof p.sessionKey === "string"
        ? p.sessionKey
        : typeof p.childSessionKey === "string"
          ? p.childSessionKey
          : null;
    // Terminal events carry the id in either `terminalId` or `id`. Try both.
    const terminalId =
      typeof p.terminalId === "string"
        ? p.terminalId
        : event.startsWith("terminal.") && typeof p.id === "string"
          ? p.id
          : null;
    const owner =
      (runId && this.tunneledRunOwners.get(runId)) ||
      (sessionKey && this.tunneledSessionOwners.get(sessionKey)) ||
      (terminalId && this.tunneledTerminalOwners.get(terminalId)) ||
      null;
    if (!owner) return;

    const node = this.nodes.get(owner);
    if (!node || node.state !== "registered") {
      // Satellite went away — clean up the registry entry and skip.
      if (runId) this.tunneledRunOwners.delete(runId);
      if (sessionKey) this.tunneledSessionOwners.delete(sessionKey);
      if (terminalId) this.tunneledTerminalOwners.delete(terminalId);
      return;
    }

    try {
      node.socket.send(
        JSON.stringify({
          type: "event.forward",
          payload: { event, payload },
          nodeId: this.localNodeId,
          timestamp: Date.now(),
        }),
      );
      log.info(
        `[FED-RELAY] forwarded event=${event} to satellite=${owner} (runId=${runId ?? "-"} sessionKey=${sessionKey ?? "-"})`,
      );
    } catch (err) {
      log.warn(
        `event.forward to ${owner} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Drop registry entries when the run is over so the maps don't
    // grow unbounded. Match common "this run is done" event names.
    if (
      event === "agent.complete" ||
      event === "agent.error" ||
      event === "agent.abort" ||
      event === "run.complete" ||
      event === "session.complete"
    ) {
      if (runId) this.tunneledRunOwners.delete(runId);
      if (sessionKey) this.tunneledSessionOwners.delete(sessionKey);
    }
    if (event === "terminal.exit" || event === "terminal.destroyed") {
      if (terminalId) this.tunneledTerminalOwners.delete(terminalId);
    }
  }

  /**
   * Wire the master's local gateway broadcaster so events forwarded from
   * satellites can be re-emitted to UI clients. Called once at gateway
   * startup. Stored as a private field via __gatewayBroadcaster to avoid
   * widening the public type surface.
   */
  setGatewayBroadcaster(broadcaster: {
    broadcast: (event: string, payload: unknown) => void;
  }): void {
    (this as unknown as { __gatewayBroadcaster?: typeof broadcaster }).__gatewayBroadcaster =
      broadcaster;
  }

  /**
   * Handle session completion notifications from satellites.
   */
  private async handleSessionComplete(nodeId: string, message: FederationMessage): Promise<void> {
    const payload = message.payload as {
      sessionKey: string;
      runId: string;
      success: boolean;
      result?: string;
      error?: string;
    };

    const correlationId =
      (message as unknown as { correlationId?: string }).correlationId || message.messageId;

    log.info(`session completed on ${nodeId}: ${payload.sessionKey} (${correlationId})`);

    // Stop tracking the session for failover (it completed normally)
    this.failoverManager.untrackSession(payload.sessionKey);

    // Find the originating session that spawned this remote session
    // The correlationId should match the original spawn request
    if (correlationId && this.pendingRequests.has(correlationId)) {
      const pending = this.pendingRequests.get(correlationId)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(correlationId);

      // Resolve the original spawn promise with the completion result
      pending.resolve({
        success: payload.success,
        sessionKey: payload.sessionKey,
        runId: payload.runId,
        reply: payload.result,
        error: payload.error,
      });

      log.debug(`resolved pending spawn request ${correlationId} with completion result`);
    } else {
      // Completion notification received but no pending request found
      // This could happen if the request already timed out or was handled differently
      log.debug(`session completion received without matching pending request: ${correlationId}`);
    }
  }

  /**
   * Handle compute route request.
   */
  private async handleComputeRoute(nodeId: string, message: FederationMessage): Promise<void> {
    const payload = message.payload as {
      requirements: ComputeRequirements;
      taskId?: string;
    };

    try {
      const result = await this.routeTask(payload.requirements);

      const response = JSON.stringify({
        type: "compute.route.result",
        payload: result,
        nodeId: "master",
        timestamp: Date.now(),
        correlationId: message.messageId,
      });

      void this.sendToNode(nodeId, response);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      void this.sendToNode(
        nodeId,
        buildErrorMessage(FederationErrorCode.INTERNAL_ERROR, error, message.messageId),
      );
    }
  }

  /**
   * Handle state sync request.
   */
  private handleStateSync(nodeId: string, message: FederationMessage): void {
    const syncPayload = this.getStateSyncPayload();
    const response = buildStateSyncAckMessage(syncPayload, message.messageId);
    void this.sendToNode(nodeId, response);
  }

  /**
   * Handle state sync messages (push/pull/ack/full).
   * Routes to the StateSyncManager.
   */
  private handleStateSyncMessage(nodeId: string, message: FederationMessage): void {
    if (!this.stateSyncManager) {
      log.warn("StateSyncManager not initialized, dropping state sync message");
      return;
    }

    const payload = message.payload as StateSyncMessage;
    if (!payload) {
      log.warn("Invalid state sync message payload");
      return;
    }

    // Route to sync manager
    this.stateSyncManager.handleSyncMessage(payload).catch((err) => {
      log.error(`Error handling state sync from ${nodeId}:`, err);
    });
  }

  /**
   * Get the StateSyncManager instance.
   */
  getStateSyncManager(): StateSyncManager | null {
    return this.stateSyncManager;
  }

  /**
   * Push a state change to the federation.
   */
  async pushStateChange(resource: SyncableResource, path: string, data: unknown): Promise<void> {
    if (!this.stateSyncManager) {
      throw new Error("StateSyncManager not initialized");
    }
    await this.stateSyncManager.pushChange(resource, path, data);
  }

  // ===========================================================================
  // Federation Event Handlers
  // ===========================================================================

  /**
   * Handle federation.event message from a satellite node.
   * Receives events from other nodes and routes them through the local event bus.
   */
  private handleFederationEvent(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as FederationEvent;

    if (!payload || typeof payload.type !== "string") {
      log.warn(`Invalid federation event from ${nodeId}`);
      return;
    }

    // Forward the event to the local event bus
    // This will emit locally and push to UI clients
    this.eventBus.receive(payload);

    // Re-broadcast to other satellites (except the sender)
    const rebroadcastMessage = buildFederationEventMessage(this.localNodeId, payload);
    for (const node of this.nodes.values()) {
      if (node.state !== "registered") continue;
      if (node.id === nodeId) continue; // Don't send back to sender
      try {
        node.socket.send(rebroadcastMessage);
      } catch (err) {
        log.warn(`failed to rebroadcast event to node ${node.id}: ${err}`);
      }
    }
  }

  /**
   * Handle memory.update message from a satellite node.
   * Processes bidirectional memory sync updates from satellites.
   */
  private async handleMemoryUpdate(nodeId: string, message: FederationMessage): Promise<void> {
    if (!this.memorySyncManager) {
      log.warn("Memory sync not enabled - dropping memory update");
      return;
    }

    const payload = message.payload as MemoryUpdateMessage;

    if (!payload || !payload.filePath || !payload.content) {
      log.warn(`Invalid memory update from ${nodeId}`);
      return;
    }

    // Find the node to get its WebSocket
    const node = this.nodes.get(nodeId);
    if (!node || node.state !== "registered") {
      log.warn(`Memory update from unregistered node: ${nodeId}`);
      return;
    }

    log.info(`Processing memory update from ${nodeId}: ${payload.filePath}`);

    try {
      // Handle the memory update through the memory sync manager
      await this.memorySyncManager.handleMemoryUpdate(payload, node.socket);
    } catch (err) {
      log.error(`Failed to handle memory update from ${nodeId}:`, err as Record<string, unknown>);
    }
  }

  // ===========================================================================
  // MCP Proxy Handlers
  // ===========================================================================

  /** Pending MCP invoke requests awaiting response */
  private pendingMCPInvokes = new Map<
    string,
    {
      resolve: (result: MCPInvokeResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  /**
   * Get all MCP servers available in the federation.
   * Aggregates MCPs from all connected nodes + local MCPs.
   */
  getMCPServers(filterNodeId?: string): MCPServerInfo[] {
    const servers: MCPServerInfo[] = [];

    // Add local MCPs from master
    const localMCPs = this.config.localManifest.capabilities.mcpServers ?? [];
    for (const mcpName of localMCPs) {
      if (filterNodeId && filterNodeId !== this.localNodeId) continue;
      servers.push({
        name: mcpName,
        nodeId: this.localNodeId,
        nodeName: this.config.localManifest.name,
        tools: [], // Would need to query actual MCP for tools
        status: "running",
      });
    }

    // Add MCPs from connected satellites
    for (const node of this.nodes.values()) {
      if (node.state !== "registered") continue;
      if (filterNodeId && filterNodeId !== node.id) continue;

      const nodeMCPs = node.manifest.capabilities.mcpServers ?? [];
      for (const mcpName of nodeMCPs) {
        servers.push({
          name: mcpName,
          nodeId: node.id,
          nodeName: node.manifest.name,
          tools: [], // Would need to query actual MCP for tools
          status: "running",
        });
      }
    }

    return servers;
  }

  /**
   * Handle MCP list request from a satellite.
   */
  private handleMCPList(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as { nodeId?: string };
    const servers = this.getMCPServers(payload.nodeId);
    const result: MCPListResult = { servers };

    const response = buildMCPListResultMessage(result, message.messageId);
    void this.sendToNode(nodeId, response);
  }

  /**
   * Handle MCP invoke request - route to the appropriate node.
   */
  private async handleMCPInvoke(nodeId: string, message: FederationMessage): Promise<void> {
    // Check permissions first
    if (!this.checkPermissionAndAudit(nodeId, "mcp.invoke")) {
      const errorResult: MCPInvokeResult = {
        success: false,
        error: "Permission denied for MCP invoke",
        sourceNodeId: this.localNodeId,
      };
      void this.sendToNode(nodeId, buildMCPInvokeResultMessage(errorResult, message.messageId));
      return;
    }

    // Handle encrypted payload if present
    const payload = this.handleEncryptedPayload(nodeId, message);
    if (!payload) {
      const errorResult: MCPInvokeResult = {
        success: false,
        error: "Failed to decrypt MCP invoke payload",
        sourceNodeId: this.localNodeId,
      };
      void this.sendToNode(nodeId, buildMCPInvokeResultMessage(errorResult, message.messageId));
      return;
    }

    if (!validateMCPInvokePayload(payload)) {
      this.auditLogger.logFailure("mcp.invoke", "Invalid MCP invoke payload", { nodeId });
      const errorResult: MCPInvokeResult = {
        success: false,
        error: "Invalid MCP invoke payload",
        sourceNodeId: this.localNodeId,
      };
      void this.sendToNode(nodeId, buildMCPInvokeResultMessage(errorResult, message.messageId));
      return;
    }

    const { mcpName, tool, args, targetNodeId } = payload;
    const startTime = Date.now();

    // Find the node that has this MCP
    const ownerNodeId: string | null = targetNodeId ?? this.findMCPOwner(mcpName);

    if (!ownerNodeId) {
      this.auditLogger.logMCPOperation(
        nodeId,
        mcpName,
        tool,
        false,
        Date.now() - startTime,
        `MCP "${mcpName}" not found`,
      );
      const errorResult: MCPInvokeResult = {
        success: false,
        error: `MCP "${mcpName}" not found in federation`,
        sourceNodeId: this.localNodeId,
      };
      void this.sendToNode(nodeId, buildMCPInvokeResultMessage(errorResult, message.messageId));
      return;
    }

    // If MCP is local, invoke directly
    if (ownerNodeId === this.localNodeId) {
      const result = await this.invokeLocalMCP(mcpName, tool, args);
      this.auditLogger.logMCPOperation(
        nodeId,
        mcpName,
        tool,
        result.success,
        Date.now() - startTime,
        result.success ? undefined : result.error,
      );
      void this.sendToNode(nodeId, buildMCPInvokeResultMessage(result, message.messageId));
      return;
    }

    // Forward to the owning node
    const forwardResult = await this.forwardMCPInvoke(ownerNodeId, { mcpName, tool, args });
    this.auditLogger.logMCPOperation(
      nodeId,
      mcpName,
      tool,
      forwardResult.success,
      Date.now() - startTime,
      forwardResult.success ? undefined : forwardResult.error,
    );
    void this.sendToNode(nodeId, buildMCPInvokeResultMessage(forwardResult, message.messageId));
  }

  /**
   * Handle MCP invoke result from a satellite.
   */
  private handleMCPInvokeResult(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as MCPInvokeResult;
    const correlationId = message.correlationId;

    if (correlationId && this.pendingMCPInvokes.has(correlationId)) {
      const pending = this.pendingMCPInvokes.get(correlationId)!;
      clearTimeout(pending.timer);
      this.pendingMCPInvokes.delete(correlationId);
      pending.resolve(payload);
    } else {
      log.debug(`received MCP invoke result without pending request: ${correlationId}`);
    }
  }

  /**
   * Find which node owns an MCP server.
   */
  private findMCPOwner(mcpName: string): string | null {
    // Check local first
    const localMCPs = this.config.localManifest.capabilities.mcpServers ?? [];
    if (localMCPs.includes(mcpName)) {
      return this.localNodeId;
    }

    // Check satellites
    for (const node of this.nodes.values()) {
      if (node.state !== "registered") continue;
      const nodeMCPs = node.manifest.capabilities.mcpServers ?? [];
      if (nodeMCPs.includes(mcpName)) {
        return node.id;
      }
    }

    return null;
  }

  /**
   * Invoke an MCP tool locally on this master node.
   * Routes to the actual MCP client for local servers.
   */
  private async invokeLocalMCP(
    mcpName: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<MCPInvokeResult> {
    log.info(`local MCP invoke: ${mcpName}.${tool}`);

    try {
      // Use the mcp-proxy which routes to registered local MCPs
      const { invokeMCP } = await import("./mcp-proxy.js");
      const result = await invokeMCP(mcpName, tool, args, this.localNodeId);
      return result;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        sourceNodeId: this.localNodeId,
      };
    }
  }

  /**
   * Forward an MCP invoke request to a satellite node.
   */
  private async forwardMCPInvoke(
    targetNodeId: string,
    request: MCPInvokeRequest,
    timeoutMs = 30000,
  ): Promise<MCPInvokeResult> {
    const node = this.nodes.get(targetNodeId);
    if (!node || node.state !== "registered") {
      return {
        success: false,
        error: `Node ${targetNodeId} is not connected`,
        sourceNodeId: this.localNodeId,
      };
    }

    const messageId = generateMessageId();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMCPInvokes.delete(messageId);
        resolve({
          success: false,
          error: "MCP invoke timeout",
          sourceNodeId: this.localNodeId,
        });
      }, timeoutMs);

      this.pendingMCPInvokes.set(messageId, { resolve, reject: () => {}, timer });

      const message = buildMCPInvokeMessage(this.localNodeId, request);
      // Inject the messageId for correlation
      const parsed = JSON.parse(message);
      parsed.messageId = messageId;
      node.socket.send(JSON.stringify(parsed));
    });
  }

  /**
   * Public method to invoke an MCP tool across the federation.
   * Used by gateway handlers and agents.
   */
  async invokeFederatedMCP(
    mcpName: string,
    tool: string,
    args: Record<string, unknown>,
    targetNodeId?: string,
  ): Promise<MCPInvokeResult> {
    // Find the node that owns this MCP
    const ownerNodeId: string | null = targetNodeId ?? this.findMCPOwner(mcpName);

    if (!ownerNodeId) {
      return {
        success: false,
        error: `MCP "${mcpName}" not found in federation`,
        sourceNodeId: this.localNodeId,
      };
    }

    // If local, invoke directly
    if (ownerNodeId === this.localNodeId) {
      return this.invokeLocalMCP(mcpName, tool, args);
    }

    // Forward to the owning node
    return this.forwardMCPInvoke(ownerNodeId, { mcpName, tool, args });
  }

  /**
   * Start heartbeat monitor for a node.
   */
  private startHeartbeatMonitor(node: ConnectedNode): void {
    node.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - node.lastHeartbeat;
      if (elapsed > this.config.heartbeatIntervalMs + this.config.heartbeatTimeoutMs) {
        log.warn(`node ${node.id} heartbeat timeout`);

        // Record missed heartbeat in health tracker
        this.healthTracker.recordHeartbeat(node.id, false);

        this.disconnectNode(node.id, "heartbeat timeout");
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Broadcast state update to all nodes.
   */
  private broadcastStateUpdate(): void {
    this.broadcastUpdate({
      updates: [
        {
          type: "capabilities",
          value: this.getConnectedNodes().map((n) => ({
            nodeId: n.id,
            capabilities: n.manifest.capabilities,
          })),
        },
      ],
    });
  }

  /**
   * Public wrapper around {@link sendToNode} for retrying a structured
   * {@link FederationMessage} from outside the hub (e.g. the DLQ retry
   * RPC). Serializes once and short-circuits if the target isn't
   * currently registered.
   */
  async retryMessageToNode(
    nodeId: string,
    message: import("./types.js").FederationMessage,
  ): Promise<boolean> {
    if (!this.isNodeConnected(nodeId)) return false;
    return this.sendToNode(nodeId, JSON.stringify(message));
  }

  /**
   * Send a message to a specific node using optimization (batching/compression).
   */
  private async sendToNode(nodeId: string, message: string): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node || node.state !== "registered") return false;

    try {
      // Parse the message to check if it needs delivery guarantees
      const parsedMessage = JSON.parse(message) as FederationMessage;

      // Use delivery manager for guaranteed message types
      if (
        parsedMessage.type === "session.spawn" ||
        parsedMessage.type === "session.complete" ||
        parsedMessage.type === "identity.sync" ||
        parsedMessage.type === "mcp.invoke"
      ) {
        this.deliveryManager.sendMessage(
          parsedMessage,
          nodeId,
          async (msg) => {
            // Guaranteed messages bypass batching so socket send errors reach retry/DLQ.
            await this.sendRawToRegisteredNode(nodeId, JSON.stringify(msg));
          },
          {
            onSuccess: (messageId) => {
              log.debug("Message delivered successfully", {
                messageId,
                type: parsedMessage.type,
                nodeId,
              });
            },
            onFailure: (messageId, error) => {
              log.error("Message delivery failed", {
                messageId,
                type: parsedMessage.type,
                nodeId,
                error,
              });
            },
          },
        );
        return true;
      } else {
        // Use optimizer for other message types
        await this.messageOptimizer.optimizeAndSend(message, nodeId, (optimizedMessage) =>
          this.sendRawToRegisteredNode(nodeId, optimizedMessage),
        );
        broadcastFederationEvent("federation.message.sent", {
          fromNodeId: parsedMessage.nodeId,
          toNodeId: nodeId,
          messageType: parsedMessage.type,
          msgId: parsedMessage.messageId ?? parsedMessage.correlationId ?? "",
          ts: Date.now(),
        });
        return true;
      }
    } catch (error) {
      log.warn("Failed to send message to node", { nodeId, error });
      try {
        const parsedMessage = JSON.parse(message) as FederationMessage;
        broadcastFederationEvent("federation.message.failed", {
          fromNodeId: parsedMessage.nodeId,
          toNodeId: nodeId,
          msgId: parsedMessage.messageId ?? parsedMessage.correlationId ?? "",
          reason: error instanceof Error ? error.message : String(error),
          ts: Date.now(),
        });
      } catch {
        // Failure telemetry should never mask the original send result.
      }
      return false;
    }
  }

  private async sendRawToRegisteredNode(nodeId: string, message: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node || node.state !== "registered") {
      throw new Error(`Node ${nodeId} is not registered`);
    }
    await sendWebSocketMessage(node.socket, message);
  }

  /**
   * Notify a satellite about a session-related event (e.g. failover migration,
   * session lifecycle changes). Delivers a `session.event.notify` message to
   * the target satellite. If the satellite is offline (or delivery fails), the
   * message is enqueued in the dead-letter-queue and replayed automatically
   * when the satellite reconnects (see `replayQueuedSessionEvents`).
   */
  async notifySessionEvent(
    satelliteNodeId: string,
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const message: FederationMessage = {
      type: "session.event.notify",
      payload: { sessionId, eventType, payload },
      nodeId: this.localNodeId,
      timestamp: Date.now(),
      messageId: randomUUID(),
    };

    const node = this.nodes.get(satelliteNodeId);
    const online = node?.state === "registered";

    const delivered = online
      ? await this.sendToNode(satelliteNodeId, JSON.stringify(message))
      : false;

    if (delivered) {
      log.info(`session event '${eventType}' delivered for ${sessionId}`, { satelliteNodeId });
      return;
    }

    // Offline or delivery failed — queue for replay on reconnect.
    getDeadLetterQueue().enqueue(
      message,
      satelliteNodeId,
      online ? "Failed to deliver session event" : "Satellite offline - session event queued",
      0,
      undefined,
      { sessionId, eventType },
    );
    log.info(`session event '${eventType}' for ${sessionId} queued for ${satelliteNodeId}`);
  }

  /**
   * Replay any session-event notifications that were dead-lettered while a
   * satellite was offline. Called from `registerNode` on (re)connect.
   */
  private replayQueuedSessionEvents(nodeId: string): void {
    const dlq = getDeadLetterQueue();
    const queued = dlq.listEntries({
      targetNodeId: nodeId,
      messageType: "session.event.notify",
      retryable: true,
    });
    if (queued.length === 0) return;

    log.info(`replaying ${queued.length} queued session event(s) for reconnected node ${nodeId}`);
    for (const entry of queued) {
      void dlq.retryEntry(entry.id, async (msg, target) => {
        const ok = await this.sendToNode(target, JSON.stringify(msg));
        if (!ok) throw new Error("send failed");
      });
    }
  }

  /**
   * Send error message to a socket.
   */
  private sendError(socket: WebSocket, code: FederationErrorCode, message: string): void {
    try {
      socket.send(buildErrorMessage(code, message));
    } catch {
      // Ignore send errors
    }
  }

  /**
   * Invoke a command on a remote node and wait for response.
   */
  // Pending request tracking for request-response pattern
  private pendingRequests: Map<
    string,
    {
      resolve: (result: {
        success: boolean;
        handle?: SessionHandle;
        reply?: string;
        error?: string;
        sessionKey?: string;
        runId?: string;
      }) => void;
      timer: NodeJS.Timeout;
      startTime: number;
    }
  > = new Map();

  private async invokeOnNode(
    nodeId: string,
    command: string,
    params: unknown,
    timeoutMs = 30000,
  ): Promise<{
    success: boolean;
    handle?: SessionHandle;
    reply?: string;
    error?: string;
    sessionKey?: string;
    runId?: string;
  }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      this.healthTracker.recordError(nodeId, "node not connected");
      return { success: false, error: "Node not connected" };
    }

    const requestId = randomUUID();
    const startTime = Date.now();
    const message = JSON.stringify({
      type: command,
      payload: params,
      nodeId: this.localNodeId,
      timestamp: startTime,
      messageId: requestId,
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        log.warn(`invokeOnNode timeout for ${command} on ${nodeId} (${requestId})`);

        // Record timeout as error
        this.healthTracker.recordError(nodeId, "request timeout");

        resolve({ success: false, error: "Request timeout" });
      }, timeoutMs);

      // Track pending request for matching response
      this.pendingRequests.set(requestId, { resolve, timer, startTime });

      // Send the request
      try {
        node.socket.send(message);
        log.debug(`invokeOnNode sent ${command} to ${nodeId} (${requestId})`);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);

        // Record send error
        this.healthTracker.recordError(nodeId, "send failed");

        resolve({ success: false, error: `Send failed: ${err}` });
      }
    });
  }

  /**
   * Handle response to a pending invoke request
   */
  handleInvokeResponse(
    messageId: string,
    result: {
      success: boolean;
      handle?: SessionHandle;
      reply?: string;
      error?: string;
      sessionKey?: string;
      runId?: string;
    },
    nodeId?: string,
  ) {
    const pending = this.pendingRequests.get(messageId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(messageId);

      // Track response latency and success/error in health tracker
      if (nodeId) {
        const now = Date.now();
        const actualLatency = now - pending.startTime;

        if (result.success) {
          this.healthTracker.recordLatency(nodeId, actualLatency);
        } else {
          this.healthTracker.recordError(nodeId, result.error || "unknown error");
        }
      }

      pending.resolve(result);
      log.debug(`invokeOnNode response received for ${messageId}: success=${result.success}`);
    }
  }

  /**
   * Handle delivery ACK message.
   */
  private handleDeliveryAck(nodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      messageId: string;
      receiverId: string;
      timestamp: number;
    };

    if (typeof payload.messageId !== "string") {
      log.warn("Invalid delivery.ack payload", { nodeId, payload });
      return;
    }

    log.debug("Received delivery ACK", {
      messageId: payload.messageId,
      nodeId,
      receiverId: payload.receiverId,
    });

    // Forward to delivery manager
    this.deliveryManager.handleAck(payload.messageId);
  }

  /**
   * Handle transcript request from a satellite node.
   */
  private handleTranscriptRequest(fromNodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      sessionKey: string;
      nodeId: string; // Target node that owns the transcript
      limit?: number;
      before?: number;
      includeTools?: boolean;
      requestId: string;
    };

    log.debug(`Routing transcript request for ${payload.sessionKey} to node ${payload.nodeId}`);

    // If the request is for the master node (us), handle it locally
    if (payload.nodeId === this.localNodeId) {
      // Import transcript sync manager
      const { getTranscriptSyncManager } = require("./transcript-sync.js");
      const syncManager = getTranscriptSyncManager();

      if (syncManager) {
        const response = syncManager.handleTranscriptRequest(payload);

        // Send response back to requesting node
        const responseMessage = JSON.stringify({
          type: "transcript.response",
          payload: response,
          nodeId: this.localNodeId,
          timestamp: Date.now(),
        });

        void this.sendToNode(fromNodeId, responseMessage);
      } else {
        // Send error response
        const errorResponse = {
          sessionKey: payload.sessionKey,
          requestId: payload.requestId,
          success: false,
          error: "Transcript sync manager not initialized",
          fromNodeId: this.localNodeId,
        };

        const responseMessage = JSON.stringify({
          type: "transcript.response",
          payload: errorResponse,
          nodeId: this.localNodeId,
          timestamp: Date.now(),
        });

        void this.sendToNode(fromNodeId, responseMessage);
      }
    } else {
      // Route to target satellite node
      const targetNode = this.nodes.get(payload.nodeId);
      if (targetNode && targetNode.state === "registered") {
        // Forward the request to the target node
        const forwardMessage = JSON.stringify({
          type: "transcript.request",
          payload: payload,
          nodeId: fromNodeId, // Keep original requester
          timestamp: Date.now(),
        });

        targetNode.socket.send(forwardMessage);
        log.debug(`Forwarded transcript request to node ${payload.nodeId}`);
      } else {
        // Send error response - target node not available
        const errorResponse = {
          sessionKey: payload.sessionKey,
          requestId: payload.requestId,
          success: false,
          error: `Target node ${payload.nodeId} not available`,
          fromNodeId: this.localNodeId,
        };

        const responseMessage = JSON.stringify({
          type: "transcript.response",
          payload: errorResponse,
          nodeId: this.localNodeId,
          timestamp: Date.now(),
        });

        void this.sendToNode(fromNodeId, responseMessage);
      }
    }
  }

  /**
   * Handle transcript response from a node.
   */
  private handleTranscriptResponse(fromNodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      sessionKey: string;
      requestId: string;
      success: boolean;
      messages?: any[];
      session?: any;
      error?: string;
      fromNodeId: string;
    };

    // Check if this response is for a local request
    const { getTranscriptSyncManager } = require("./transcript-sync.js");
    const syncManager = getTranscriptSyncManager();

    if (syncManager) {
      // Handle locally if we have pending requests
      syncManager.handleTranscriptResponse(payload);
    }

    // If the response came through us as a hub, we might need to route it back
    // to the original requester (this handles the case where we're routing between satellites)
    // The actual routing logic would be more complex in practice, but this is the basic structure
    log.debug(`Received transcript response for ${payload.sessionKey} from ${fromNodeId}`);
  }

  /**
   * Handle real-time transcript stream from a node.
   */
  private handleTranscriptStream(fromNodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      sessionKey: string;
      message: any;
      fromNodeId: string;
    };

    log.debug(`Streaming transcript message for ${payload.sessionKey} from ${fromNodeId}`);

    // Handle locally if we have transcript sync manager
    const { getTranscriptSyncManager } = require("./transcript-sync.js");
    const syncManager = getTranscriptSyncManager();

    if (syncManager) {
      syncManager.handleStreamedMessage(payload);
    }

    // Broadcast to interested nodes (in a real implementation, we'd track subscriptions)
    for (const [nodeId, node] of this.nodes.entries()) {
      if (nodeId !== fromNodeId && node.state === "registered") {
        const streamMessage = JSON.stringify({
          type: "transcript.stream",
          payload: payload,
          nodeId: this.localNodeId,
          timestamp: Date.now(),
        });

        node.socket.send(streamMessage);
      }
    }
  }

  /**
   * Handle peer discovery request from satellite.
   */
  private handlePeerDiscovery(fromNodeId: string, message: FederationMessage): void {
    const payload = message.payload as {
      requestingNodeId: string;
      requireCapabilities?: string[];
    };

    log.debug(`peer discovery request from ${fromNodeId}`, payload);

    // Get all registered satellites (exclude master and requesting node)
    const availablePeers: NodeManifest[] = [];

    for (const [nodeId, node] of this.nodes) {
      // Skip requesting node and ensure node is registered
      if (nodeId === fromNodeId || node.state !== "registered") {
        continue;
      }

      // Filter by capabilities if specified
      if (payload.requireCapabilities && payload.requireCapabilities.length > 0) {
        const hasRequiredCaps = payload.requireCapabilities.every((cap) => {
          switch (cap) {
            case "ollama":
              return node.manifest.capabilities.hasOllama;
            case "comfyui":
              return node.manifest.capabilities.hasComfyUI;
            case "voice":
              return node.manifest.capabilities.hasVoice;
            case "gpu":
              return node.manifest.capabilities.gpu !== undefined;
            default:
              // Check MCP servers
              return node.manifest.capabilities.mcpServers.includes(cap);
          }
        });

        if (!hasRequiredCaps) {
          continue;
        }
      }

      // Add to available peers
      availablePeers.push(node.manifest);
    }

    // Send peer discovery result
    const discoveryResult = {
      availablePeers,
      timestamp: Date.now(),
    };

    const responseMessage = JSON.stringify({
      type: "peer.discovery.result",
      payload: discoveryResult,
      nodeId: this.localNodeId,
      timestamp: Date.now(),
      messageId: generateMessageId(),
      correlationId: message.messageId,
    });

    void this.sendToNode(fromNodeId, responseMessage);

    log.debug(
      `sent peer discovery result to ${fromNodeId}: ${availablePeers.length} peers available`,
    );
  }

  /**
   * Build local node manifest from config.
   */
  private buildLocalManifest(): NodeManifest {
    const cfg = loadConfig();
    const hostname = osHostname();
    const ollamaStatus = getLastOllamaStatus();

    return {
      id: `master_${hostname.replace(/[^a-zA-Z0-9]/g, "_")}`,
      name: cfg.federation?.nodeName ?? hostname,
      hostname,
      port: cfg.gateway?.port ?? 18789,
      workspace: process.cwd(),
      capabilities: {
        hasOllama: ollamaStatus?.running ?? cfg.federation?.capabilities?.hasOllama ?? false,
        ollamaModels:
          ollamaStatus?.running && ollamaStatus.models.length > 0 ? ollamaStatus.models : undefined,
        hasComfyUI: cfg.federation?.capabilities?.hasComfyUI ?? false,
        hasVoice: cfg.federation?.capabilities?.hasVoice ?? false,
        mcpServers: [], // MCP servers are discovered at runtime
        agents: cfg.agents ? Object.keys(cfg.agents) : [],
        workspaces: [process.cwd()],
        platform: process.platform,
        arch: process.arch,
      },
      isMaster: true,
    };
  }

  private handleFileTransferMessage(fromNodeId: string, message: FederationMessage): void {
    const payload = message.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const targetNodeId = (payload.toNodeId ?? payload.fromNodeId) as string | undefined;

    // Emit so the file-transfer engine (registered via onFileTransferMessage) can handle locally.
    this.emit("file-transfer:message", message.type, payload, fromNodeId);

    // Forward to the target node if it is a remote node (hub acting as relay).
    if (targetNodeId && targetNodeId !== fromNodeId && targetNodeId !== this.localNodeId) {
      void this.sendToNode(targetNodeId, JSON.stringify(message));
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let defaultHub: FederationHub | null = null;

/**
 * Get the default federation hub instance.
 */
export function getFederationHub(): FederationHub | null {
  return defaultHub;
}

/**
 * Initialize the federation hub.
 */
export function initFederationHub(config?: FederationHubConfig): FederationHub {
  if (defaultHub) {
    log.warn("federation hub already initialized, returning existing instance");
    return defaultHub;
  }
  defaultHub = new FederationHub(config);
  return defaultHub;
}

/**
 * Start the default federation hub.
 */
export async function startFederationHub(config?: FederationHubConfig): Promise<FederationHub> {
  const hub = initFederationHub(config);
  await hub.start();
  return hub;
}

/**
 * Stop the default federation hub.
 */
export async function stopFederationHub(): Promise<void> {
  if (defaultHub) {
    await defaultHub.stop();
    defaultHub = null;
  }
}

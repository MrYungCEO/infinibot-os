/**
 * Federation Satellite
 *
 * Client for satellite nodes to connect to the master federation hub.
 * Handles:
 * - WebSocket connection to master gateway
 * - Registration with local capabilities
 * - Heartbeat and health reporting
 * - State synchronization
 * - Reconnection with exponential backoff
 * - Processing remote session requests
 */

import { isShareAllowed, notSharedMessage, type FederationShare } from "./share-policy.js";
import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedDir, resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { getLastOllamaStatus } from "../ollama/ensure-ollama.js";
import type {
  NodeManifest,
  NodeCapabilities,
  StateUpdate,
  StateSyncPayload,
  FederationMessage,
  FederationMessageType,
  FederationConfig,
  NodeLoadMetrics,
  MCPInvokeRequest,
  MCPInvokeResult,
  MCPListRequest,
  MCPListResult,
  PeerDiscoveryResult,
  SessionSpawnRequest,
  SessionHandle,
  RoleChangePayload,
} from "./types.js";
import { ResourceMonitor, initResourceMonitor } from "./resource-monitor.js";
import {
  collectHardwareSnapshot,
  snapshotMeaningfullyChanged,
  type HardwareSnapshot as HardwareSnapshotPayload,
} from "./hardware-collector.js";
import { serializeSession, restoreSession, type SessionState } from "../agents/session-state.js";
import {
  FEDERATION_PROTOCOL_VERSION,
  DEFAULT_HEARTBEAT_INTERVAL,
  deserializeMessage,
  buildHeartbeatMessage,
  buildCapabilitiesMessage,
  buildStateSyncRequestMessage,
  isValidMessageType,
  generateNodeId,
  generateMessageId,
  buildDeliveryAckMessage,
  type NodeRegisterAckPayload,
  type NodeHeartbeatAckPayload,
  type StateSyncAckPayload,
  type StateUpdatePayload,
  type ErrorPayload,
} from "./protocol.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { DEFAULT_FAILOVER_CONFIG, FederationError, FederationErrorCode } from "./types.js";
import {
  IdentitySyncManager,
  initIdentitySyncManager,
  type IdentitySyncPayload,
} from "./identity-sync.js";
import { MemorySyncManager, initMemorySyncManager } from "./memory-sync.js";
import { MemoryFileWatcher, initFileWatcher } from "./file-watcher.js";
import { MessageOptimizer, createMessageOptimizer } from "./message-optimizer.js";
import { PeerMeshManager, initPeerMesh, type PeerConnection } from "./peer-mesh.js";
import { sendWebSocketMessage } from "./ws-send.js";
import {
  FederationDiscoveryManager,
  discoverMaster,
  type DiscoveredMaster,
  isDiscoveryAvailable,
} from "./discovery.js";
import {
  FederationSecurity,
  getFederationSecurity,
  type SatelliteToken,
  type PermissionLevel,
  type EncryptedPayload,
} from "./security.js";
import { getFederationAuditLogger, audit } from "./audit-log.js";
import {
  resolveSatelliteAuthToken,
  writeSatelliteCredential,
  tokenFingerprint,
} from "./paired-devices.js";
import { collectDeviceCapabilities, type DeviceCapabilities } from "./device-capabilities.js";

const log = createSubsystemLogger("federation").child("satellite");

/**
 * Resolve the externally-reachable federation WebSocket URL that this
 * satellite advertises to the master. Priority:
 *   1. Explicit `federation.publicUrl` from config — user knows best.
 *   2. Derived `ws://{hostname}:{port}/federation` — works on LANs where
 *      the master can resolve the satellite's OS hostname (e.g. via
 *      mDNS / `.local`). Fragile across NAT, but better than nothing —
 *      lets mobile voice attempt a direct connection. The master's
 *      `federation.nodes.list` handler does the same fallback if this
 *      field is missing entirely, so older satellites still surface
 *      a URL.
 *
 * Strips a `/federation` suffix from publicUrl if present (so users can
 * either include it or not) and re-appends it so the resulting URL has
 * the canonical shape the mobile `nodeHttpBase` helper expects.
 */
export function resolveGatewayUrl(
  publicUrl: string | undefined,
  host: string,
  port: number,
): string {
  if (publicUrl && publicUrl.trim()) {
    const trimmed = publicUrl.trim().replace(/\/+$/, "");
    if (trimmed.endsWith("/federation")) return trimmed;
    return `${trimmed}/federation`;
  }
  return `ws://${host}:${port}/federation`;
}

// =============================================================================
// Types
// =============================================================================

/** Satellite configuration */
export interface SatelliteConfig {
  /** Master gateway WebSocket URL (e.g., ws://192.168.1.100:47913/federation) */
  masterUrl?: string;
  /** Ordered master gateway URLs for failover, primary first */
  masters?: string[];
  /** Time to wait before switching masters after disconnect (default: 30000) */
  masterFailoverTimeoutMs?: number;
  /** Node display name */
  nodeName?: string;
  /** Local workspace path */
  workspace?: string;
  /** Local capabilities to advertise */
  capabilities?: Partial<NodeCapabilities>;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
  /** Maximum reconnect attempts (default: unlimited) */
  maxReconnectAttempts?: number;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Enable peer-to-peer mesh connections (default: true) */
  enablePeerMesh?: boolean;
  /** Port for peer-to-peer connections (default: 47914) */
  peerPort?: number;
  /** Maximum peer connections (default: 20) */
  maxPeerConnections?: number;
  /** Enable auto-discovery of master via mDNS (default: false) */
  autoDiscover?: boolean;
  /** Discovery timeout in ms for auto-discovery (default: 10000) */
  discoveryTimeoutMs?: number;
  /** mDNS service type for discovery (default: _infinibot-federation._tcp) */
  discoveryServiceType?: string;
  /** Keep scanning for better masters after connecting (default: false) */
  continuousDiscovery?: boolean;
  /** Authentication token for federation access */
  authToken?: SatelliteToken;
  /**
   * Stable node id. Defaults to `federation.nodeId` from config so a device
   * keeps the same identity on the master across restarts and reconnects.
   */
  nodeId?: string;
  /** Permission level (will be set by token validation) */
  permissionLevel?: PermissionLevel;
  /** What the master may use on this machine (unset categories stay shared). */
  share?: FederationShare;
}

export interface SatelliteStatus {
  state: SatelliteState;
  nodeId: string;
  nodeName: string;
  masterUrl: string;
  masterUrls: string[];
  connectedAt: number | null;
  lastHeartbeatAck: number | null;
  latencyMs: number | null;
  reconnectAttempts: number;
  lastError: { code: string; message: string; at: number } | null;
  paired: boolean;
  credentialFingerprint: string | null;
  credentialKind: "none" | "invite" | "device";
  permissionLevel: PermissionLevel;
  capabilities: NodeCapabilities;
}

/** `<state>/federation/satellite-status.json` — read by the desktop app. */
export function satelliteStatusPath(): string {
  return path.join(resolveSharedDir(), "federation", "satellite-status.json");
}

function safeLoadFederationConfig(): { authToken?: unknown; nodeId?: unknown } | undefined {
  try {
    return loadConfig().federation as { authToken?: unknown; nodeId?: unknown } | undefined;
  } catch {
    return undefined;
  }
}

function normalizeNodeId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const id = v.trim();
  // Ids travel in RPC params and file names — keep them boring.
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : undefined;
}

/** Satellite connection state */
export type SatelliteState =
  | "disconnected"
  | "connecting"
  | "registering"
  | "connected"
  | "reconnecting";

/** Satellite events */
export interface SatelliteEvents {
  "state:change": (state: SatelliteState, prevState: SatelliteState) => void;
  connected: (nodeId: string) => void;
  disconnected: (reason: string) => void;
  registered: (nodeId: string) => void;
  "state:sync": (payload: StateSyncPayload) => void;
  "state:update": (update: StateUpdate) => void;
  "session:spawn:request": (request: unknown) => void;
  "session:send:request": (request: unknown) => void;
  "identity:sync": (data: { files: string[]; success: boolean; masterNodeId: string }) => void;
  "password:sync": (password: string) => void;
  "update:available": (data: { localVersion: string; masterVersion: string }) => void;
  "update:complete": (data: { oldVersion: string; newVersion: string }) => void;
  "update:failed": (data: { error: string }) => void;
  "peer:connected": (nodeId: string, manifest: NodeManifest) => void;
  "peer:disconnected": (nodeId: string, reason: string) => void;
  "peer:discovery": (peers: NodeManifest[]) => void;
  "audit-log": (entry: { from: string; to: string; reason: string; ts: number }) => void;
  error: (error: Error) => void;
}

// =============================================================================
// Satellite Class
// =============================================================================

export class FederationSatellite extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<SatelliteConfig>;
  private manifest: NodeManifest;
  private state: SatelliteState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAck: number | null = null;
  private lastLatencyMs: number | null = null;
  private connectedAt: number | null = null;
  private lastError: { code: string; message: string; at: number } | null = null;
  private deviceCapabilities: DeviceCapabilities | null = null;
  private currentLoad = 0;
  private activeSessions = 0;
  private stateVersion = 0;
  private federatedNodes: NodeManifest[] = [];
  private closed = false;
  private masterUrls: string[] = [];
  private currentMasterIndex = 0;
  private masterFailoverTimer: NodeJS.Timeout | null = null;
  private resourceMonitor: ResourceMonitor | null = null;
  private lastMetrics: NodeLoadMetrics | null = null;
  private hardwareTimer: NodeJS.Timeout | null = null;
  private lastHardwareSnapshot: HardwareSnapshotPayload | null = null;
  private lastHardwarePushAt = 0;
  private identitySyncManager: IdentitySyncManager | null = null;
  private memorySyncManager: MemorySyncManager | null = null;
  private fileWatcher: MemoryFileWatcher | null = null;
  private peerMesh: PeerMeshManager | null = null;
  private pendingMCPInvokes?: Map<
    string,
    {
      resolve: (result: MCPInvokeResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  /**
   * Pending satellite→master gateway invokes keyed by correlation id. Each
   * entry's `resolve` is called once the master's `master.gateway.invoke.result`
   * lands on the WebSocket. Used to proxy business.* RPCs from a satellite's
   * UI through to the master's gateway so the master owns the source of truth.
   */
  private pendingMasterInvokes?: Map<
    string,
    {
      resolve: (result: {
        success: boolean;
        data?: unknown;
        error?: { code?: string; message?: string };
      }) => void;
      timer: NodeJS.Timeout;
    }
  >;
  private deliveryManager = getDeliveryManager();
  private messageOptimizer: MessageOptimizer;
  private discoveryManager: FederationDiscoveryManager | null = null;
  private discoveredMasters: Map<string, DiscoveredMaster> = new Map();
  private security: FederationSecurity;
  private satelliteKeyPair?: { publicKey: string; privateKey: string };
  private encryptionSession?: {
    sessionId: string;
    sharedSecret: Buffer;
    symmetricKey: Buffer;
    iv: Buffer;
  };
  private auditLogger = getFederationAuditLogger();
  /**
   * Local gateway broadcaster injected by the satellite's own gateway
   * runtime. When master forwards events via event.forward (agent text
   * deltas, terminal output, tool calls for tunneled runs), we
   * re-broadcast them on this so the satellite's UI clients see them
   * exactly as if the run had happened locally. Optional — without it,
   * cross-device streaming silently no-ops.
   */
  private localBroadcaster: { broadcast: (event: string, payload: unknown) => void } | null = null;
  /**
   * Last gateway version reported by master (via heartbeat/config payload).
   * Read by the production updater to offer a "match master (vX)" pin so a
   * satellite can align with whatever the master fleet is running.
   */
  private lastKnownMasterVersion: string | null = null;

  constructor(config: SatelliteConfig) {
    super();

    const masterUrls = this.resolveMasterUrls(config);
    if (masterUrls.length === 0) {
      throw new Error("masterUrl or masters is required");
    }
    this.masterUrls = masterUrls;

    this.config = {
      masterUrl: masterUrls[0],
      masters: masterUrls,
      masterFailoverTimeoutMs:
        config.masterFailoverTimeoutMs ?? DEFAULT_FAILOVER_CONFIG.failoverTimeoutMs ?? 30_000,
      nodeName: config.nodeName ?? hostname(),
      workspace: config.workspace ?? process.cwd(),
      capabilities: config.capabilities ?? {},
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL,
      reconnectDelayMs: config.reconnectDelayMs ?? 1000,
      maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? Infinity,
      autoReconnect: config.autoReconnect ?? true,
      enablePeerMesh: config.enablePeerMesh ?? true,
      peerPort: config.peerPort ?? 47914,
      maxPeerConnections: config.maxPeerConnections ?? 20,
      autoDiscover: config.autoDiscover ?? false,
      discoveryTimeoutMs: config.discoveryTimeoutMs ?? 10000,
      discoveryServiceType: config.discoveryServiceType ?? "_infinibot-federation._tcp",
      continuousDiscovery: config.continuousDiscovery ?? false,
      // The invite token (or the durable credential the master issued on the
      // first join). Both satellite start-up paths used to drop it, so every
      // invite-joined satellite was refused with "Federation requires a valid
      // registration token" and never became a node.
      authToken: (config.authToken ??
        resolveSatelliteAuthToken(safeLoadFederationConfig()?.authToken)) as SatelliteToken,
      permissionLevel: config.permissionLevel ?? "read-only",
      nodeId: config.nodeId ?? normalizeNodeId(safeLoadFederationConfig()?.nodeId) ?? "",
      share: config.share ?? {},
    };

    this.manifest = this.buildLocalManifest();

    // Initialize identity sync manager to receive soul/memory files from master
    this.identitySyncManager = initIdentitySyncManager({
      nodeId: this.manifest.id,
      workspace: this.config.workspace,
      syncPassword: true, // Satellites always accept password sync
    });

    // Forward password sync events
    this.identitySyncManager.setEmitter((event, data) => {
      if (event === "password:sync") {
        this.emit("password:sync", data);
      }
    });

    // Initialize memory sync manager for bidirectional memory sync
    this.memorySyncManager = initMemorySyncManager({
      workspace: this.config.workspace,
      nodeId: this.manifest.id,
      conflictResolution: "last-write-wins",
    });

    // Set up communication handler for sending updates to master
    this.memorySyncManager.setHandlers({
      emitToMaster: (type: string, data: unknown) => {
        this.sendToMaster(type, data).catch((error) => {
          log.error("Failed to emit to master", {
            type,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });

    // Initialize file watcher for detecting memory changes
    this.fileWatcher = initFileWatcher({
      workspace: this.config.workspace,
      debounceMs: 500,
      watchDailyNotes: true,
    });
    this.memorySyncManager.setFileWatcher(this.fileWatcher);

    log.info("Memory sync enabled - satellite will sync memory changes to master");

    // Initialize security manager
    this.security = getFederationSecurity();

    // Generate satellite key pair for encryption
    this.satelliteKeyPair = this.security.generateKeyPair();
    log.info("Generated satellite key pair for E2E encryption");

    // Initialize message optimizer for batching and compression
    this.messageOptimizer = createMessageOptimizer(this.manifest.id, {
      compressionEnabled: true,
      batchingEnabled: true,
    });

    log.info("Message optimizer initialized - batching and compression enabled");
  }

  private resolveMasterUrls(config: SatelliteConfig): string[] {
    const urls: string[] = [];
    const add = (url: string | undefined) => {
      const trimmed = url?.trim();
      if (!trimmed || urls.includes(trimmed)) return;
      urls.push(trimmed);
    };

    add(config.masterUrl);
    for (const url of config.masters ?? []) {
      add(url);
    }

    return urls;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Perform auto-discovery of master nodes via mDNS
   */
  private async performAutoDiscovery(): Promise<void> {
    if (!(await isDiscoveryAvailable())) {
      throw new Error("Auto-discovery requested but mDNS library not available");
    }

    log.info("Starting auto-discovery of master nodes...", {
      serviceType: this.config.discoveryServiceType,
      timeout: this.config.discoveryTimeoutMs,
    });

    try {
      const master = await discoverMaster(
        this.config.discoveryTimeoutMs,
        this.config.discoveryServiceType,
      );

      if (master) {
        log.info("Master node discovered via mDNS", {
          nodeId: master.nodeId,
          nodeName: master.nodeName,
          host: master.host,
          port: master.port,
          wsUrl: master.wsUrl,
        });

        // Update the masterUrl with the discovered master
        this.config.masterUrl = master.wsUrl;
        this.discoveredMasters.set(master.nodeId, master);

        // Start continuous discovery if enabled
        if (this.config.continuousDiscovery) {
          this.startContinuousDiscovery();
        }
      } else {
        throw new Error(`No master nodes discovered within ${this.config.discoveryTimeoutMs}ms`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Auto-discovery failed", { error: error.message });
      throw new Error(`Auto-discovery failed: ${error.message}`);
    }
  }

  /**
   * Start continuous discovery for better masters
   */
  private startContinuousDiscovery(): void {
    if (this.discoveryManager) {
      return; // Already running
    }

    log.info("Starting continuous master discovery");

    this.discoveryManager = new FederationDiscoveryManager();

    this.discoveryManager.on("master-discovered", (master: DiscoveredMaster) => {
      log.info("New master discovered during continuous scan", {
        nodeId: master.nodeId,
        nodeName: master.nodeName,
        host: master.host,
        port: master.port,
      });

      this.discoveredMasters.set(master.nodeId, master);

      // TODO: Implement master switching logic based on criteria like:
      // - Lower latency
      // - Higher capabilities
      // - Load balancing
      // For now, just log the discovery
    });

    this.discoveryManager.on("master-lost", (nodeId: string) => {
      log.info("Master node lost during continuous scan", { nodeId });
      this.discoveredMasters.delete(nodeId);
    });

    this.discoveryManager.on("error", (error: Error) => {
      log.error("Continuous discovery error", { error: error.message });
    });

    this.discoveryManager.startScanning(this.config.discoveryServiceType).catch((error) => {
      log.error("Failed to start continuous discovery", { error: error.message });
      this.discoveryManager = null;
    });
  }

  /**
   * Stop continuous discovery
   */
  private async stopContinuousDiscovery(): Promise<void> {
    if (this.discoveryManager) {
      await this.discoveryManager.destroy();
      this.discoveryManager = null;
      log.info("Continuous discovery stopped");
    }
  }

  /**
   * Connect to the master federation hub.
   */
  async connect(): Promise<void> {
    this.startWakeDetector();
    if (this.state !== "disconnected" && this.state !== "reconnecting") {
      throw new Error(`Cannot connect from state: ${this.state}`);
    }

    this.closed = false;

    // If auto-discovery is enabled and no masterUrl is provided, try to discover
    if (this.config.autoDiscover && (this.config.masterUrl === "auto" || !this.config.masterUrl)) {
      await this.performAutoDiscovery();
    }

    this.setState("connecting");

    return new Promise((resolve, reject) => {
      log.info(`connecting to master: ${this.config.masterUrl}`);

      try {
        this.ws = new WebSocket(this.config.masterUrl, {
          // 128 MB: a master.gateway.invoke.result for a large knowledge-graph
          // snapshot (graph.global.snapshot) can exceed the old 10 MB cap, which
          // made `ws` reject the frame (close 1009) — dropping the result AND
          // resetting the whole federation connection, so the satellite saw a
          // 30 s timeout on the node graph and intermittent master-data loss.
          maxPayload: 128 * 1024 * 1024,
        });
      } catch (err) {
        this.setState("disconnected");
        reject(err);
        return;
      }

      const connectTimeout = setTimeout(() => {
        if (this.state === "connecting") {
          this.ws?.close();
          this.setState("disconnected");
          reject(new Error("Connection timeout"));
        }
      }, 30000);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        log.info("connected to master, registering...");
        this.setState("registering");
        this.sendRegistration().catch((error) => {
          log.error("Failed to send registration", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data).catch((error) => {
          log.error("Failed to handle message", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      this.ws.on("close", (code, reason) => {
        clearTimeout(connectTimeout);
        const reasonStr = reason?.toString() || `code ${code}`;
        this.handleDisconnect(reasonStr);

        if (this.state === "connecting" || this.state === "registering") {
          reject(new Error(`Connection closed: ${reasonStr}`));
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        log.error(`connection error: ${error.message}`);
        if (this.state !== "connected") {
          this.lastError = {
            code: "UNREACHABLE",
            message: `Can't reach the master at ${this.config.masterUrl}: ${error.message}`,
            at: Date.now(),
          };
          this.writeStatusFile(true);
        }
        this.emit("error", error);

        if (this.state === "connecting") {
          this.setState("disconnected");
          reject(error);
        }
      });

      // Registration success is handled in handleMessage
      // We resolve when we receive node.register.ack
      this.once("registered", () => {
        resolve();
      });
    });
  }

  /**
   * Disconnect from the master hub.
   */
  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.wakeTimer) {
      clearInterval(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.stopHeartbeat();
    this.stopReconnectTimer();
    this.stopResourceMonitoring();
    this.stopHardwarePush();
    this.stopFileWatcher();
    await this.stopPeerMesh();
    await this.stopContinuousDiscovery();

    // Shutdown message optimizer
    this.messageOptimizer.shutdown();

    if (this.ws) {
      try {
        // Send graceful disconnect message
        const disconnectMsg = JSON.stringify({
          type: "node.disconnect",
          payload: { reason: "graceful shutdown", reconnect: false },
          nodeId: this.manifest.id,
          timestamp: Date.now(),
        });
        this.ws.send(disconnectMsg);
      } catch {
        // Ignore send errors
      }

      this.ws.close(1000, "graceful shutdown");
      this.ws = null;
    }

    this.setState("disconnected");
    log.info("disconnected from master");
  }

  /**
   * Get current connection state.
   */
  getState(): SatelliteState {
    return this.state;
  }

  /**
   * Get local node manifest.
   */
  getManifest(): NodeManifest {
    return this.manifest;
  }

  /**
   * Connection status for the satellite's own UI (desktop status panel).
   * Contains no secrets — only a short credential fingerprint.
   */
  getStatus(): SatelliteStatus {
    return {
      state: this.state,
      nodeId: this.manifest.id,
      nodeName: this.manifest.name,
      masterUrl: this.config.masterUrl,
      masterUrls: [...this.masterUrls],
      connectedAt: this.state === "connected" ? this.connectedAt : null,
      lastHeartbeatAck: this.lastHeartbeatAck,
      latencyMs: this.lastLatencyMs,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      paired: Boolean(this.config.authToken),
      credentialFingerprint: this.config.authToken ? tokenFingerprint(this.config.authToken) : null,
      credentialKind: !this.config.authToken
        ? "none"
        : this.config.authToken.expiresAt
          ? "invite"
          : "device",
      permissionLevel: this.config.permissionLevel,
      capabilities: this.manifest.capabilities,
    };
  }

  /**
   * Mirror getStatus() into `<state>/federation/satellite-status.json` so the
   * desktop app (which has no gateway client) can show connection, latency
   * and the last error. No secrets: only a credential fingerprint.
   */
  private lastStatusWrite = 0;
  private writeStatusFile(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastStatusWrite < 2_000) return;
    this.lastStatusWrite = now;
    try {
      const file = satelliteStatusPath();
      const { capabilities, ...status } = this.getStatus();
      const body = JSON.stringify({
        ...status,
        device: capabilities?.device ?? null,
        updatedAt: now,
        pid: process.pid,
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, "utf-8");
      fs.renameSync(tmp, file);
    } catch {
      /* status mirror is best effort */
    }
  }

  /**
   * Sleep / suspend detection: a 5 s timer that fires 30 s+ late means the
   * machine was asleep — the socket is almost certainly dead, so reconnect at
   * once instead of waiting for the heartbeat watchdog.
   */
  private wakeTimer: NodeJS.Timeout | null = null;
  private startWakeDetector(): void {
    if (this.wakeTimer) return;
    let last = Date.now();
    this.wakeTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > 35_000 && !this.closed) {
        log.info(`clock jumped ${Math.round(gap / 1000)}s (sleep/resume) — reconnecting`);
        this.reconnectNow("resume");
      }
      this.writeStatusFile(false);
    }, 5_000);
    this.wakeTimer.unref?.();
  }

  /** Drop the current socket and reconnect now (e.g. after the OS wakes up). */
  reconnectNow(reason = "manual"): void {
    if (this.closed) return;
    log.info(`reconnect requested (${reason})`);
    this.stopReconnectTimer();
    this.reconnectAttempts = 0;
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        /* close handler reconnects */
      }
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * Get all federated nodes (from last state sync).
   */
  getFederatedNodes(): NodeManifest[] {
    return this.federatedNodes;
  }

  /**
   * Update local capabilities and notify master.
   */
  updateCapabilities(capabilities: Partial<NodeCapabilities>): void {
    this.manifest.capabilities = {
      ...this.manifest.capabilities,
      ...capabilities,
    };

    if (this.state === "connected" && this.ws) {
      const msg = buildCapabilitiesMessage(this.manifest.id, this.manifest.capabilities);
      this.ws.send(msg);
    }
  }

  /**
   * Update load and session count (for heartbeats).
   */
  updateLoad(load: number, activeSessions: number): void {
    this.currentLoad = Math.max(0, Math.min(100, load));
    this.activeSessions = Math.max(0, activeSessions);
  }

  /**
   * Request state sync from master.
   */
  requestStateSync(): void {
    if (this.state !== "connected" || !this.ws) return;

    const msg = buildStateSyncRequestMessage(this.manifest.id, this.stateVersion);
    this.ws.send(msg);
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Set connection state and emit event.
   */
  private setState(newState: SatelliteState): void {
    const prevState = this.state;
    if (prevState === newState) return;

    this.state = newState;
    this.emit("state:change", newState, prevState);
    this.writeStatusFile(true);

    if (newState === "connected") {
      this.reconnectAttempts = 0;
    }
  }

  /**
   * Send registration message to master with security information.
   */
  private async sendRegistration(): Promise<void> {
    if (!this.ws) return;

    // Create enhanced registration payload with security information
    const payload = {
      manifest: this.manifest,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      // Include satellite's public key for encryption
      publicKey: this.satelliteKeyPair?.publicKey,
      // Include authentication token if provided
      token: this.config.authToken,
    };

    const msg = JSON.stringify({
      type: "node.register",
      payload,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      messageId: generateMessageId(),
    });

    try {
      await this.messageOptimizer.optimizeAndSend(msg, "master", (optimizedMessage) => {
        this.ws!.send(optimizedMessage);
      });

      log.debug("Sent registration with security information", {
        hasPublicKey: !!this.satelliteKeyPair?.publicKey,
        hasToken: !!this.config.authToken,
      });
    } catch (err) {
      log.error(`Failed to send registration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Send a message to the master hub using optimization.
   */
  private async sendToMaster(type: string, data: unknown): Promise<void> {
    if (!this.ws || this.state !== "connected") {
      log.debug(`Cannot send ${type} to master - not connected`);
      return;
    }

    const message = JSON.stringify({
      type,
      payload: data,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
    });

    try {
      await this.messageOptimizer.optimizeAndSend(
        message,
        "master", // targetNodeId for batching
        (optimizedMessage) => {
          this.ws!.send(optimizedMessage);
        },
      );
      log.debug(`Sent ${type} to master`);
    } catch (err) {
      log.error(
        `Failed to send ${type} to master: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Handle incoming message from master.
   */
  private async handleMessage(data: unknown): Promise<void> {
    const str = typeof data === "string" ? data : (data as Buffer).toString("utf-8");

    try {
      // First, process through message optimizer to handle batched/compressed messages
      const processedMessages = await this.messageOptimizer.processReceived(str);

      // Handle each message in the processed array
      for (const messageStr of processedMessages) {
        await this.handleSingleMessage(messageStr);
      }
    } catch (err) {
      log.error(`failed to process message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle a single federation message.
   */
  private async handleSingleMessage(messageStr: string): Promise<void> {
    let message: FederationMessage;

    // DEBUG: Log all incoming messages to file
    const debugLog = (msg: string) => {
      try {
        const { appendFileSync } = require("node:fs");
        appendFileSync(
          "C:\\tmp\\satellite-spawn-debug.log",
          `${new Date().toISOString()} ${msg}\n`,
        );
      } catch {
        /* ignore */
      }
    };
    debugLog(
      `[MSG] Raw message received (${messageStr.length} chars): ${messageStr.substring(0, 200)}`,
    );

    try {
      message = deserializeMessage(messageStr);
    } catch (err) {
      // Include raw payload preview so protocol mismatches / wrong-endpoint
      // connections (e.g. master in standalone mode returning a gateway
      // connect.challenge instead of node.register.ack) are immediately
      // diagnosable from the satellite log.
      log.error(
        `invalid message: ${err instanceof Error ? err.message : String(err)} — raw: ${messageStr.slice(0, 400)}`,
      );
      debugLog(`[MSG] Deserialization failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    debugLog(`[MSG] Parsed message type: ${message.type}, messageId: ${message.messageId}`);

    if (!isValidMessageType(message.type)) {
      log.debug(`unknown message type: ${message.type}`);
      debugLog(`[MSG] Unknown message type: ${message.type}`);
      return;
    }

    // Handle delivery guarantees for guaranteed message types
    if (
      message.messageId &&
      (message.type === "session.spawn" ||
        message.type === "session.send" ||
        message.type === "identity.sync" ||
        message.type === "mcp.invoke")
    ) {
      // Check for duplicates
      if (this.deliveryManager.isDuplicate(message.messageId, "master")) {
        log.debug("Dropping duplicate message", {
          messageId: message.messageId,
          type: message.type,
        });
        // Still send ACK for duplicates to prevent retries
        if (this.ws) {
          const ack = buildDeliveryAckMessage(message.messageId, this.manifest.id);
          this.ws.send(ack);
        }
        return;
      }

      // Send ACK for guaranteed messages
      if (this.ws) {
        const ack = buildDeliveryAckMessage(message.messageId, this.manifest.id);
        this.ws.send(ack);

        log.debug("Sent delivery ACK", {
          messageId: message.messageId,
          type: message.type,
        });
      }
    }

    switch (message.type) {
      case "node.register.ack":
        void this.handleRegisterAck(message.payload as NodeRegisterAckPayload);
        break;
      case "node.heartbeat.ack":
        this.handleHeartbeatAck(message.payload as NodeHeartbeatAckPayload);
        break;
      case "state.sync.ack":
        this.handleStateSyncAck(message.payload as StateSyncAckPayload);
        break;
      case "state.update":
        this.handleStateUpdate(message.payload as StateUpdatePayload);
        break;
      case "session.spawn":
        this.handleSessionSpawn(message);
        break;
      case "session.send":
        this.handleSessionSend(message);
        break;
      case "session.getState":
        void this.handleSessionGetState(message);
        break;
      case "session.createMigrated":
        void this.handleSessionCreateMigrated(message);
        break;
      case "session.cleanup":
        void this.handleSessionCleanup(message);
        break;
      case "gateway.proxy.invoke":
        // Generic local-gateway RPC proxy. Anything the master sends here
        // (terminal.create, terminal.write, terminal.getBuffer, etc.) gets
        // forwarded to the satellite's local gateway via the same callGateway
        // path the local CLI uses. Reply lands as `gateway.proxy.invoke.result`.
        this.handleGatewayProxyInvoke(message);
        break;
      case "gateway.proxy.invoke.stream.cancel":
        this.handleStreamCancel(message);
        break;
      case "error":
        this.handleError(message.payload as ErrorPayload);
        break;
      case "identity.sync":
        void this.handleIdentitySync(message.payload as IdentitySyncPayload);
        break;
      case "mcp.invoke":
        void this.handleMCPInvoke(message);
        break;
      case "mcp.list":
        void this.handleMCPList(message);
        break;
      case "mcp.invoke.result":
        this.handleMCPInvokeResult(message);
        break;
      case "master.gateway.invoke.result":
        this.handleMasterInvokeResult(message);
        break;
      case "delivery.ack":
        this.handleDeliveryAck(message);
        break;
      case "transcript.request":
        this.handleTranscriptRequest(message);
        break;
      case "transcript.response":
        this.handleTranscriptResponse(message);
        break;
      case "transcript.stream":
        this.handleTranscriptStream(message);
        break;
      case "memory.broadcast":
        void this.handleMemoryBroadcast(message);
        break;
      case "event.forward":
        this.handleEventForward(message);
        break;
      case "peer.discovery.result":
        this.handlePeerDiscoveryResult(message);
        break;
      case "system.update":
        void this.handleSystemUpdate(message);
        break;
      case "role.change":
        void this.handleRoleChange(message.payload as import("./types.js").RoleChangePayload);
        break;
      default:
        log.debug(`unhandled message type: ${message.type}`);
    }
  }

  /**
   * Handle registration acknowledgment.
   */
  private async handleRegisterAck(payload: NodeRegisterAckPayload): Promise<void> {
    if (!payload.success) {
      log.error(`registration failed: ${payload.error}`);
      this.emit(
        "error",
        new FederationError(
          FederationErrorCode.UNAUTHORIZED,
          payload.error ?? "Registration failed",
        ),
      );
      void this.disconnect();
      return;
    }

    // Update node ID if assigned by master
    if (payload.nodeId && payload.nodeId !== this.manifest.id) {
      this.manifest.id = payload.nodeId;
    }

    // Handle security information from hub
    const securityPayload = payload as any;
    if (
      securityPayload.hubPublicKey &&
      securityPayload.encryptedSharedSecret &&
      this.satelliteKeyPair
    ) {
      try {
        // Decrypt the shared secret from hub
        const encryptedSecret = Buffer.from(securityPayload.encryptedSharedSecret, "base64");
        const { privateDecrypt, createHash } = await import("node:crypto");
        const sharedSecret = privateDecrypt(this.satelliteKeyPair.privateKey, encryptedSecret);

        // Derive symmetric key and IV
        const symmetricKey = createHash("sha256").update(sharedSecret).digest();
        const iv = createHash("md5").update(sharedSecret).digest();

        this.encryptionSession = {
          sessionId: securityPayload.sessionId || "default",
          sharedSecret,
          symmetricKey,
          iv,
        };

        log.info("Established E2E encryption session with hub");
        this.auditLogger.logSuccess("encryption.establish", {
          satelliteId: this.manifest.id,
          resource: this.encryptionSession.sessionId,
        });
      } catch (error) {
        log.error("Failed to establish encryption session", { error });
        this.auditLogger.logFailure(
          "encryption.establish",
          error instanceof Error ? error : "Unknown error",
          {
            satelliteId: this.manifest.id,
          },
        );
      }
    }

    // First join with an invite: the master hands back a durable per-device
    // credential. Store it (0600, never logged) and use it from now on.
    const credential = payload.security?.credential;
    if (credential && credential.satelliteId && credential.signature) {
      try {
        writeSatelliteCredential({
          token: credential,
          masterUrl: this.config.masterUrl,
          hubFingerprint: payload.security?.publicKeyFingerprint,
        });
        this.config.authToken = credential;
        log.info(
          `paired with master — device credential saved (fingerprint ${tokenFingerprint(credential)})`,
        );
      } catch (err) {
        log.warn(
          `could not save device credential: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.lastError = null;
    this.connectedAt = Date.now();
    const grantedLevel = (this.config.authToken as SatelliteToken | undefined)?.permissions?.level;
    if (grantedLevel) this.config.permissionLevel = grantedLevel;

    // Store permission information
    if (securityPayload.permissions) {
      this.config.permissionLevel = securityPayload.permissions.level;
      log.info(`Permission level: ${securityPayload.permissions.level}`, {
        allowedOperations: securityPayload.permissions.allowedOperations?.length || 0,
      });
    }

    log.info(`registered with master as ${this.manifest.id}`);
    this.setState("connected");
    this.stopMasterFailoverTimer();

    // Start resource monitoring for load-aware heartbeats
    this.startResourceMonitoring();

    // Start pushing full HardwareSnapshots to master for live UI panels
    this.startHardwarePush();

    this.startHeartbeat();
    this.retryPendingDeliveriesToMaster();

    // Start file watcher for memory sync
    void this.startFileWatcher();

    // Initialize peer mesh for satellite-to-satellite communication
    void this.initializePeerMesh();

    // Point local voice handlers at master's voice containers. Fires
    // after the federation handshake completes so we have a confirmed
    // masterUrl to derive hostnames from. Idempotent — running it again
    // with the same masterHost is a no-op.
    void this.bootstrapVoiceFromMaster();

    this.emit("registered", this.manifest.id);
    this.emit("connected", this.manifest.id);
  }

  /**
   * Auto-wire the satellite's voice handlers to the master's voice
   * containers. Extracts hostname from `config.masterUrl` and writes
   * canonical URLs (Kokoro 8882, Speaches 8002, LiveKit 7882) into
   * `~/.infinibot/infinibot.json` under the `voice` block.
   *
   * The master-explicit override path (sharedConfig.voice in
   * applySharedConfig) wins over this — once an operator has pushed
   * specific URLs from master, the auto path stops touching them
   * (controlled by `autoFromMaster=false` flag set there).
   *
   * Skipped when:
   *   - this node IS the master (no parent gateway)
   *   - we can't parse `masterUrl` (mDNS still discovering)
   *   - user pinned URLs manually (autoFromMaster === false)
   */
  private async bootstrapVoiceFromMaster(): Promise<void> {
    try {
      const masterUrl = this.config.masterUrl;
      if (!masterUrl) return;
      let masterHost: string;
      try {
        masterHost = new URL(masterUrl).hostname;
      } catch {
        // masterUrl might be a bare host:port without protocol.
        const m = masterUrl.match(/^(?:\w+:\/\/)?([^:/]+)/);
        masterHost = m?.[1] ?? "";
      }
      if (!masterHost || masterHost === "localhost" || masterHost === "127.0.0.1") {
        // Local-only or unresolvable — leave the satellite's voice URLs alone.
        return;
      }

      const { readConfigFileSnapshot, writeConfigFile } = await import("../config/io.js");
      const snapshot = await readConfigFileSnapshot();
      const parsed = snapshot.parsed;
      const current: Record<string, unknown> =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : {};

      const existingVoice = (current.voice ?? {}) as Record<string, unknown>;
      // If the operator manually pinned URLs (autoFromMaster=false), respect
      // their choice. Same if a master-explicit override has already landed.
      if (existingVoice.autoFromMaster === false) {
        log.debug("voice bootstrap skipped — operator-pinned URLs in config");
        return;
      }
      // No-op when we already auto-pointed at this same master.
      if (existingVoice.autoFromMaster === true && existingVoice.masterHost === masterHost) {
        return;
      }

      const nextVoice = {
        kokoroUrl: `http://${masterHost}:8882`,
        speachesUrl: `http://${masterHost}:8002`,
        livekitUrl: `ws://${masterHost}:7882`,
        livekitUrlExternal: `ws://${masterHost}:7882`,
        autoFromMaster: true,
        masterHost,
      };
      current.voice = { ...existingVoice, ...nextVoice };

      const { sanitizeMergedConfig } = await import("../config/sanitize.js");
      sanitizeMergedConfig(current);

      await writeConfigFile(current as never);
      log.info(
        `voice URLs auto-wired to master: kokoro=${nextVoice.kokoroUrl}, speaches=${nextVoice.speachesUrl}, livekit=${nextVoice.livekitUrl}`,
      );
      this.emit("voice:auto-wired", nextVoice);
    } catch (err) {
      log.warn("voice bootstrap failed:", err as Record<string, unknown>);
    }
  }

  /**
   * Encrypt sensitive payload if encryption session is established
   */
  private encryptPayload(payload: any): EncryptedPayload | any {
    if (!this.encryptionSession || !this.security.shouldEncryptPayload("session.spawn")) {
      return payload; // Return original payload if encryption not available/needed
    }

    try {
      const { createCipheriv } = require("node:crypto");
      const plaintext = JSON.stringify(payload);
      const cipher = createCipheriv(
        "aes-256-cbc",
        this.encryptionSession.symmetricKey,
        this.encryptionSession.iv,
      );

      let encrypted = cipher.update(plaintext, "utf8", "base64");
      encrypted += cipher.final("base64");

      return {
        encrypted,
        iv: this.encryptionSession.iv.toString("base64"),
        sessionId: this.encryptionSession.sessionId,
      } as EncryptedPayload;
    } catch (error) {
      log.error("Failed to encrypt payload", { error });
      return payload; // Fallback to unencrypted
    }
  }

  /**
   * Decrypt encrypted payload
   */
  private decryptPayload(encryptedPayload: EncryptedPayload): any {
    if (!this.encryptionSession) {
      throw new Error("No encryption session available for decryption");
    }

    try {
      const { createDecipheriv } = require("node:crypto");
      const decipher = createDecipheriv(
        "aes-256-cbc",
        this.encryptionSession.symmetricKey,
        this.encryptionSession.iv,
      );

      let decrypted = decipher.update(encryptedPayload.encrypted, "base64", "utf8");
      decrypted += decipher.final("utf8");

      return JSON.parse(decrypted);
    } catch (error) {
      log.error("Failed to decrypt payload", { error });
      throw error;
    }
  }

  /**
   * Handle heartbeat acknowledgment.
   */
  private handleHeartbeatAck(payload: NodeHeartbeatAckPayload): void {
    this.lastHeartbeatAck = Date.now();
    const latencyMs = this.lastHeartbeatAck - payload.timestamp;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) this.lastLatencyMs = latencyMs;
    this.writeStatusFile(false);
    log.debug(`heartbeat ack, latency: ${latencyMs}ms`);
  }

  /**
   * Handle state sync response.
   */
  private handleStateSyncAck(payload: StateSyncAckPayload): void {
    this.stateVersion = payload.version;
    this.federatedNodes = payload.nodes;
    log.info(`state synced, version: ${payload.version}, nodes: ${payload.nodes.length}`);
    this.emit("state:sync", payload);
  }

  /**
   * Handle state update broadcast.
   */
  private handleStateUpdate(payload: StateUpdatePayload): void {
    this.stateVersion = payload.version;
    log.debug(`state update, version: ${payload.version}`);
    this.emit("state:update", payload);
  }

  /**
   * Handle session spawn request from master.
   */
  /** What this satellite shares with its master (federation.share). */
  getSharePolicy(): FederationShare {
    return this.config.share;
  }

  private handleSessionSpawn(message: FederationMessage): void {
    log.info("received session spawn request from master", {
      messageId: message.messageId,
    });

    if (!isShareAllowed(this.config.share, "agents")) {
      log.info("[SPAWN] refused: this satellite does not share agent runs");
      if (message.messageId) {
        this.sendSessionResult("session.spawn.result", message.messageId, {
          success: false,
          error: notSharedMessage("agents"),
        });
      }
      return;
    }

    const payload =
      typeof message.payload === "object" && message.payload !== null ? message.payload : {};

    const listenerCount = this.listenerCount("session:spawn:request");
    if (listenerCount === 0) {
      log.warn("[SPAWN] no listeners for session:spawn:request — spawn will be dropped", {
        messageId: message.messageId,
      });
    } else {
      log.debug("[SPAWN] emitting session:spawn:request", {
        messageId: message.messageId,
        listenerCount,
        agentId: (payload as Record<string, unknown>).agentId,
      });
    }

    this.emit("session:spawn:request", {
      ...(payload as Record<string, unknown>),
      correlationId: message.messageId,
    });
  }

  /**
   * Generic gateway proxy from master. The master sends `gateway.proxy.invoke`
   * with `{ method, params }` and we hand it off to whoever's listening on
   * the satellite-mode handler (server-runtime-state) to dispatch through
   * `callGateway`. The result comes back via `sendGatewayProxyResult`.
   *
   * If `stream: true` is set, the proxy request expects a chunked response —
   * the listener should return an AsyncIterable or the large result will be
   * split into `gateway.proxy.invoke.stream` messages keyed by the
   * correlation id.
   */
  private handleGatewayProxyInvoke(message: FederationMessage): void {
    const payload = (
      typeof message.payload === "object" && message.payload !== null ? message.payload : {}
    ) as Record<string, unknown>;
    this.emit("gateway:proxy:request", {
      ...payload,
      correlationId: message.messageId,
    });
  }

  /**
   * Forward a local broadcaster event up to the master. Used for terminal
   * output streaming + lifecycle events so the master UI can render remote
   * PTYs as if they were local.
   *
   * Master-side, the hub re-broadcasts these as `event` with the satellite's
   * `nodeId` injected into the payload so UI clients can route to the right
   * panel.
   */
  async sendEventToMaster(event: string, payload: unknown): Promise<void> {
    if (!this.ws || this.state !== "connected") return;
    const wrapped = {
      type: "event.broadcast",
      payload: { event, payload },
      nodeId: this.manifest.id,
      timestamp: Date.now(),
    };
    try {
      this.ws.send(JSON.stringify(wrapped));
    } catch (err) {
      log.debug(`event.broadcast send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Ask the master to push a fresh identity sync. The master responds via the
   * existing `identity.sync` channel — files land in this satellite's
   * workspace through `handleIdentitySync` as they always do, so callers don't
   * await a return value here. UI surfaces refresh after a short delay.
   *
   * Returns whether the request was queued (false when no master connection).
   */
  async requestIdentitySync(): Promise<boolean> {
    if (!this.ws || this.state !== "connected") {
      log.debug("requestIdentitySync: not connected to master");
      return false;
    }
    try {
      await this.sendToMaster("identity.sync.request", {
        requestedAt: Date.now(),
        nodeId: this.manifest.id,
      });
      log.info("Sent identity.sync.request to master");
      return true;
    } catch (err) {
      log.warn(
        `identity.sync.request send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Reply to a `gateway.proxy.invoke` message. Used by server-runtime-state
   * after it calls the local gateway and gets the result.
   */
  sendGatewayProxyResult(
    correlationId: string,
    result: { success: boolean; payload?: unknown; error?: string },
  ): void {
    if (!this.ws || this.state !== "connected") {
      log.warn(
        `Cannot send gateway.proxy.invoke.result - not connected (correlationId=${correlationId})`,
      );
      return;
    }
    const messageData: FederationMessage = {
      type: "gateway.proxy.invoke.result",
      payload: result,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId,
    };
    try {
      this.ws.send(JSON.stringify(messageData));
    } catch (err) {
      log.error(
        `gateway.proxy.invoke.result send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Send a single chunk of a streamed `gateway.proxy.invoke` response. Used
   * by the satellite when the original request had `stream: true` and the
   * handler yields multiple chunks (or chunks a large payload).
   */
  sendStreamChunk(
    correlationId: string,
    chunk: { index: number; payload: unknown; done: boolean },
  ): void {
    if (!this.ws || this.state !== "connected") {
      log.warn(
        `Cannot send gateway.proxy.invoke.stream - not connected (correlationId=${correlationId})`,
      );
      return;
    }
    const messageData: FederationMessage = {
      type: "gateway.proxy.invoke.stream",
      payload: { ...chunk, correlationId },
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId,
    };
    try {
      this.ws.send(JSON.stringify(messageData));
    } catch (err) {
      log.error(
        `gateway.proxy.invoke.stream send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Handle a `gateway.proxy.invoke.stream.cancel` from the master — the
   * consumer broke out of the AsyncIterable early. Emit an event so the
   * streaming handler can clean up.
   */
  private handleStreamCancel(message: FederationMessage): void {
    const correlationId =
      (message as unknown as { correlationId?: string }).correlationId ?? message.messageId;
    log.info(`stream cancel received (correlationId=${correlationId})`);
    this.emit("gateway:proxy:stream:cancel", { correlationId });
  }

  /**
   * Handle session send request from master.
   */
  private handleSessionSend(message: FederationMessage): void {
    log.info("received session send request from master");
    const payload =
      typeof message.payload === "object" && message.payload !== null ? message.payload : {};
    this.emit("session:send:request", {
      ...(payload as Record<string, unknown>),
      correlationId: message.messageId,
    });
  }

  /**
   * Handle system update request from master.
   * Performs: git pull, npm run build, then restart.
   */
  private async handleSystemUpdate(message: FederationMessage): Promise<void> {
    log.info("received system update request from master");
    const correlationId = message.messageId ?? `update-${Date.now()}`;
    const payload = (message.payload ?? {}) as { skipBuild?: boolean; branch?: string };

    // Send acknowledgment that we're starting
    this.sendSystemUpdateResult(correlationId, {
      success: true,
      phase: "starting",
      message: "Starting update process",
    });

    try {
      const { exec, execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const execFileAsync = promisify(execFile);
      const cwd = this.config.workspace ?? process.cwd();

      // Phase 1: Git pull
      log.info("[UPDATE] Running git pull...");
      this.sendSystemUpdateResult(correlationId, {
        success: true,
        phase: "git-pull",
        message: "Pulling latest code",
      });

      // The branch comes from the network: validate it as a plain git ref and
      // pass it as an argv entry (no shell), so it can't smuggle commands.
      const branch = normalizeUpdateBranch(payload.branch);
      const { stdout: gitOut, stderr: gitErr } = await execFileAsync(
        "git",
        ["pull", "origin", branch],
        { cwd },
      );
      log.info(`[UPDATE] Git pull result: ${gitOut || gitErr}`);

      // Phase 2: Build (unless skipped)
      if (!payload.skipBuild) {
        log.info("[UPDATE] Running npm run build...");
        this.sendSystemUpdateResult(correlationId, {
          success: true,
          phase: "building",
          message: "Building project",
        });

        const { stdout: buildOut, stderr: buildErr } = await execAsync("npm run build", {
          cwd,
          timeout: 120_000, // 2 minute timeout for build
        });
        log.info(`[UPDATE] Build result: ${buildOut.slice(-500)}`);
        if (buildErr && !buildOut.includes("Done")) {
          log.warn(`[UPDATE] Build stderr: ${buildErr.slice(-200)}`);
        }
      }

      // Phase 3: Schedule restart
      log.info("[UPDATE] Update complete, scheduling restart...");
      this.sendSystemUpdateResult(correlationId, {
        success: true,
        phase: "restarting",
        message: "Restarting gateway",
      });

      // Restart via gateway call after a short delay
      setTimeout(async () => {
        try {
          const { callGateway } = await import("../gateway/call.js");
          await callGateway({
            method: "gateway.restart",
            params: { reason: "Fleet update from master" },
            timeoutMs: 5000,
          });
        } catch (err) {
          // If callGateway fails, try direct SIGUSR1
          log.warn(`[UPDATE] callGateway restart failed, trying SIGUSR1: ${err}`);
          process.kill(process.pid, "SIGUSR1");
        }
      }, 1000);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`[UPDATE] Failed: ${error}`);
      this.sendSystemUpdateResult(correlationId, {
        success: false,
        phase: "error",
        message: `Update failed: ${error}`,
        error,
      });
    }
  }

  /**
   * Handle role.change message from master — this satellite is promoted to master.
   * Reconfigures itself as master, updates config, then restarts the gateway.
   */
  private async handleRoleChange(payload: RoleChangePayload): Promise<void> {
    if (payload.newRole !== "master") {
      log.warn("[ROLE] Ignoring role.change with unsupported newRole");
      return;
    }

    log.info("[ROLE] Received role.change — promoting this node to master");

    try {
      // Update config: change mode to master, clear masterUrl
      const config = loadConfig();
      if (!config.federation) {
        (config as Record<string, unknown>).federation = { mode: "master" as const };
      }
      config.federation!.mode = "master";
      config.federation!.masterUrl = undefined;
      if (payload.federationPort) {
        config.federation!.federationPort = payload.federationPort;
      }
      config.federation!.enabled = true;
      await writeConfigFile(config);

      log.info("[ROLE] Config updated to master mode. Scheduling gateway restart...");

      // Disconnect from the old master cleanly
      try {
        await this.disconnect();
      } catch {
        // Best-effort — we're restarting anyway
      }

      // Restart the gateway so it reinitializes as master hub
      setTimeout(async () => {
        try {
          const { callGateway } = await import("../gateway/call.js");
          await callGateway({
            method: "gateway.restart",
            params: { reason: "Role change: promoted to master" },
            timeoutMs: 5000,
          });
        } catch {
          process.kill(process.pid, "SIGUSR1");
        }
      }, 500);

      this.emit("role-change" as string, "master");
    } catch (err) {
      log.error(
        `[ROLE] Failed to reconfigure as master: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Send system update result back to master.
   */
  private sendSystemUpdateResult(
    correlationId: string,
    result: { success: boolean; phase: string; message: string; error?: string },
  ): void {
    if (!this.ws || this.state !== "connected") {
      log.warn(`Cannot send system.update.result - not connected`);
      return;
    }

    const message = JSON.stringify({
      type: "system.update.result",
      payload: result,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId,
    });

    try {
      this.ws.send(message);
      log.debug(`sent system.update.result: ${result.phase}`);
    } catch (err) {
      log.error(`failed to send system.update.result: ${err}`);
    }
  }

  /**
   * Handle session state request for migration.
   */
  private async handleSessionGetState(message: FederationMessage): Promise<void> {
    log.info("received session state request from master");

    const payload = message.payload as { sessionKey: string };
    const result = await this.getSessionState(payload.sessionKey);

    // Send response back to master
    if (this.ws && this.state === "connected") {
      const responseMessage = JSON.stringify({
        type: "session.getState.result",
        payload: result,
        nodeId: this.manifest.id,
        timestamp: Date.now(),
        correlationId: message.messageId,
      });

      try {
        this.ws.send(responseMessage);
        log.debug(`sent session state response: ${payload.sessionKey}`);
      } catch (err) {
        log.error(`failed to send session state response: ${err}`);
      }
    }
  }

  /**
   * Handle session creation from migrated state.
   */
  private async handleSessionCreateMigrated(message: FederationMessage): Promise<void> {
    log.info("received session create from migrated state request from master");

    const payload = message.payload as { state: SessionState };
    const result = await this.createMigratedSession(payload.state);

    // Send response back to master
    if (this.ws && this.state === "connected") {
      const responseMessage = JSON.stringify({
        type: "session.createMigrated.result",
        payload: result,
        nodeId: this.manifest.id,
        timestamp: Date.now(),
        correlationId: message.messageId,
      });

      try {
        this.ws.send(responseMessage);
        log.debug(`sent session creation response: ${result.sessionKey || "failed"}`);
      } catch (err) {
        log.error(`failed to send session creation response: ${err}`);
      }
    }
  }

  /**
   * Handle session cleanup request.
   */
  private async handleSessionCleanup(message: FederationMessage): Promise<void> {
    log.info("received session cleanup request from master");

    const payload = message.payload as { sessionKey: string; reason?: string };
    const result = await this.cleanupMigratedSession(payload.sessionKey, payload.reason);

    // Send response back to master
    if (this.ws && this.state === "connected") {
      const responseMessage = JSON.stringify({
        type: "session.cleanup.result",
        payload: result,
        nodeId: this.manifest.id,
        timestamp: Date.now(),
        correlationId: message.messageId,
      });

      try {
        this.ws.send(responseMessage);
        log.debug(`sent session cleanup response: ${payload.sessionKey}`);
      } catch (err) {
        log.error(`failed to send session cleanup response: ${err}`);
      }
    }
  }

  /**
   * Handle error message from master.
   */
  private handleError(payload: ErrorPayload): void {
    log.error(`error from master: ${payload.code} - ${payload.message}`);
    // Only errors that explain why we are NOT connected are worth showing; a
    // connected satellite also gets benign ones (e.g. an unsupported optional
    // message type on an older master).
    if (this.state !== "connected" || payload.code === FederationErrorCode.UNAUTHORIZED) {
      this.lastError = {
        code: String(payload.code),
        message: String(payload.message),
        at: Date.now(),
      };
    }
    if (
      payload.code === FederationErrorCode.UNAUTHORIZED ||
      payload.code === FederationErrorCode.PROTOCOL_MISMATCH
    ) {
      // Retrying a refused join every second only floods the master's audit
      // log; jump straight to the slowest retry until the operator fixes it.
      this.reconnectAttempts = Math.max(this.reconnectAttempts, 16);
    }
    this.emit("error", new FederationError(payload.code as FederationErrorCode, payload.message));
  }

  /**
   * Handle identity sync from master (SOUL.md, MEMORY.md, etc. + password).
   */
  private async handleIdentitySync(payload: IdentitySyncPayload): Promise<void> {
    log.info(`Receiving identity sync from master ${payload.masterNodeId}`);

    if (!this.identitySyncManager) {
      log.error("Identity sync manager not initialized");
      return;
    }

    try {
      const ack = await this.identitySyncManager.handleIdentitySync(payload);
      log.info(`Identity sync complete: ${ack.filesReceived.length} files received`);

      // Apply API keys to environment (so satellites can use master's
      // keys for any code path that reads process.env directly — e.g. the
      // embedded agent's auth-store fallback) AND persist them into the
      // satellite's `models.providers.<id>.apiKey` so a process restart
      // doesn't lose them, the wizard's status panels show "configured",
      // and tools that read the config (not env) also see the keys.
      if (payload.apiKeys) {
        const appliedKeys: string[] = [];
        for (const [key, value] of Object.entries(payload.apiKeys)) {
          if (value && !process.env[key]) {
            // Local override (an env var the operator set on this satellite)
            // takes precedence — we never clobber an explicit choice.
            process.env[key] = value;
            appliedKeys.push(key);
          }
        }
        if (appliedKeys.length > 0) {
          log.info(`API keys synced from master (env): ${appliedKeys.join(", ")}`);
        }
        // Persist to config — separate concern from env-var application
        // so this still runs even when env vars were already set.
        await this.persistMasterApiKeys(payload.apiKeys);
      }

      // Write auth profiles to disk (for agent authentication)
      if (payload.authProfiles) {
        await this.applyAuthProfiles(payload.authProfiles);
      }

      // Apply shared infinibot.json config blocks (notion creds + DB ids,
      // model providers, loops, mcpServers) so the satellite talks to the
      // same databases + integrations as the master. Without this, every
      // satellite has to re-run the Notion / provider wizards.
      if (payload.sharedConfig) {
        await this.applySharedConfig(payload.sharedConfig);
      }

      // Check version and auto-update if needed
      if (payload.version) {
        this.lastKnownMasterVersion = payload.version;
        await this.checkAndAutoUpdate(payload.version);
      }

      // Persist master's gateway password to local config so this
      // satellite's gateway shares federation auth. Without this, every
      // satellite needs its own independent token + every operator has to
      // re-paste it on each device. The persist runs BEFORE the emit so
      // any external listener (e.g. live gateway re-resolving auth on the
      // next connection) sees the value already on disk.
      if (payload.gatewayPassword) {
        await this.persistMasterGatewayPassword(payload.gatewayPassword);
        this.emit("password:sync", payload.gatewayPassword);
        log.info("Gateway password synced from master");
      }

      // Emit identity sync event
      this.emit("identity:sync", {
        files: ack.filesReceived,
        success: ack.success,
        masterNodeId: payload.masterNodeId,
      });
    } catch (err) {
      log.error("Identity sync failed:", err as Record<string, unknown>);
    }
  }

  /**
   * Apply auth profiles received from master to local .infinibot directory.
   */
  /**
   * Write the master's gateway password into this satellite's local
   * infinibot.json so the satellite's own gateway shares federation auth
   * with master. Adopting the master's password means a client paired
   * with the master can talk to any satellite gateway with the same
   * credential.
   *
   * The write also clears any pre-existing `gateway.auth.token` and
   * switches `auth.mode` to `password` so resolveGatewayAuth picks the
   * synced value. We never touch other gateway fields (port, bind), so
   * each device keeps its own networking config. If master and satellite
   * are already in sync this is a no-op.
   */
  /**
   * Write master's API keys into this satellite's
   * `models.providers.<id>.apiKey` so they survive a restart, populate
   * the wizard's status panel, and reach code paths that read provider
   * config instead of env vars. Env-var application is a separate step
   * in handleIdentitySync; this method covers the persisted side.
   *
   * Mapping mirrors collectApiKeys on the master: same env-name →
   * provider-id correspondence in reverse. Only fills entries that are
   * empty locally — operator-set values are never overwritten.
   */
  private async persistMasterApiKeys(
    apiKeys: NonNullable<IdentitySyncPayload["apiKeys"]>,
  ): Promise<void> {
    try {
      const envToProvider: Record<string, string[]> = {
        ANTHROPIC_API_KEY: ["anthropic"],
        OPENAI_API_KEY: ["openai"],
        GOOGLE_API_KEY: ["google"],
        GEMINI_API_KEY: ["gemini"],
        REPLICATE_API_TOKEN: ["replicate"],
        XAI_API_KEY: ["xai"],
      };

      const { readConfigFileSnapshot, writeConfigFile } = await import("../config/io.js");
      const { sanitizeMergedConfig } = await import("../config/sanitize.js");

      const snapshot = await readConfigFileSnapshot();
      const parsed = snapshot.parsed;
      const current: Record<string, unknown> =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : {};

      const models = (current.models as Record<string, unknown> | undefined) ?? {};
      const providers = (models.providers as Record<string, unknown> | undefined) ?? {};

      const filled: string[] = [];
      for (const [envName, value] of Object.entries(apiKeys)) {
        if (!value || typeof value !== "string") continue;
        const providerIds = envToProvider[envName];
        if (!providerIds) continue;
        for (const id of providerIds) {
          const existing = (providers[id] as Record<string, unknown> | undefined) ?? {};
          const existingKey = typeof existing.apiKey === "string" ? existing.apiKey.trim() : "";
          if (existingKey) continue; // never overwrite an operator value
          providers[id] = { ...existing, apiKey: value };
          filled.push(`${id}<-${envName}`);
        }
      }

      if (filled.length === 0) return;

      models.providers = providers;
      current.models = models;
      sanitizeMergedConfig(current);
      await writeConfigFile(current as never);
      log.info(`Persisted master API keys to local providers: ${filled.join(", ")}`);
    } catch (err) {
      log.warn(
        `Failed to persist master API keys: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async persistMasterGatewayPassword(password: string): Promise<void> {
    try {
      const { readConfigFileSnapshot, writeConfigFile } = await import("../config/io.js");
      const { sanitizeMergedConfig } = await import("../config/sanitize.js");

      const snapshot = await readConfigFileSnapshot();
      const parsed = snapshot.parsed;
      const current: Record<string, unknown> =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : {};

      const gateway = (current.gateway as Record<string, unknown> | undefined) ?? {};
      const auth = (gateway.auth as Record<string, unknown> | undefined) ?? {};

      // No-op when already in sync — saves an unnecessary disk write +
      // log line on every reconnect.
      if (auth.mode === "password" && auth.password === password) {
        return;
      }

      auth.mode = "password";
      auth.password = password;
      // The autogenerated token from quickstart.finalize is no longer the
      // active credential — strip it so the gateway can't fall back to a
      // stale value if mode changes again.
      delete auth.token;

      gateway.auth = auth;
      current.gateway = gateway;

      sanitizeMergedConfig(current);
      await writeConfigFile(current as never);
      log.info("Persisted master gateway password to local config");
    } catch (err) {
      log.warn(
        `Failed to persist master gateway password: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async applyAuthProfiles(authProfiles: Record<string, string>): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");

    // Same state dir resolveAgentDir reads from (INFINIBOT_STATE_DIR, else
    // <home>/.infinibot) — HOME is unset on Windows and ignores the override.
    const agentsDir = join(resolveStateDir(), "agents");

    let applied = 0;
    for (const [relPath, content] of Object.entries(authProfiles)) {
      try {
        const fullPath = join(agentsDir, relPath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
        applied++;
        log.debug(`Wrote auth profile: ${relPath}`);
      } catch (err) {
        log.warn(`Failed to write auth profile ${relPath}:`, err as Record<string, unknown>);
      }
    }

    if (applied > 0) {
      log.info(`Auth profiles synced from master: ${applied} files written`);
    }
  }

  /**
   * Persist the shared infinibot.json blocks pushed from master. Each block
   * is overwritten wholesale (master is authoritative); satellite-local
   * fields outside these blocks are preserved by reading the on-disk
   * snapshot first and merging.
   *
   * Uses `readConfigFileSnapshot` to survive validation failures in
   * unrelated parts of the satellite's config — `loadConfig` would return
   * `{}` and clobber the rest of the file.
   */
  private async applySharedConfig(
    sharedConfig: NonNullable<IdentitySyncPayload["sharedConfig"]>,
  ): Promise<void> {
    try {
      const { readConfigFileSnapshot, writeConfigFile } = await import("../config/io.js");
      const { sanitizeMergedConfig } = await import("../config/sanitize.js");

      const snapshot = await readConfigFileSnapshot();
      const parsed = snapshot.parsed;
      const current: Record<string, unknown> =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : {};

      const applied: string[] = [];

      if (sharedConfig.notion) {
        current.notion = sharedConfig.notion;
        applied.push("notion");
      }

      if (sharedConfig.models?.providers) {
        // Preserve any non-providers fields under `models` (defaults,
        // primary, etc.) that the satellite may have set locally.
        const existingModels =
          current.models && typeof current.models === "object" && !Array.isArray(current.models)
            ? { ...(current.models as Record<string, unknown>) }
            : {};
        existingModels.providers = sharedConfig.models.providers;
        current.models = existingModels;
        applied.push("models.providers");
      }

      if (sharedConfig.loops) {
        current.loops = sharedConfig.loops;
        applied.push("loops");
      }

      if (sharedConfig.mcpServers) {
        current.mcpServers = sharedConfig.mcpServers;
        applied.push("mcpServers");
      }

      if (sharedConfig.voice) {
        // Master-sent voice URLs override the auto-derived ones — this is
        // the path for setups where the voice containers aren't on the
        // same host as the federation gateway, or use non-default ports.
        current.voice = { ...sharedConfig.voice, autoFromMaster: false };
        applied.push("voice");
      }

      if (applied.length === 0) return;

      // Defensive: the master's config may carry blocks that fail the
      // satellite's stricter validation (e.g. provider entries missing a
      // `models: []` array). Shared with quickstart + writeNotionConfig.
      sanitizeMergedConfig(current);

      await writeConfigFile(current as never);
      log.info(`Shared config synced from master: ${applied.join(", ")}`);
    } catch (err) {
      log.warn("Failed to apply shared config from master:", err as Record<string, unknown>);
    }
  }

  /**
   * Handle memory broadcast from master.
   * Receives memory file updates from the master and applies them locally.
   */
  private async handleMemoryBroadcast(message: FederationMessage): Promise<void> {
    if (!this.memorySyncManager) {
      log.warn("Memory sync not enabled - dropping memory broadcast");
      return;
    }

    const payload = message.payload as any; // MemoryBroadcastMessage

    if (!payload || !payload.filePath || !payload.content) {
      log.warn("Invalid memory broadcast payload");
      return;
    }

    log.info(`Receiving memory broadcast from master: ${payload.filePath}`);

    try {
      // Apply the memory update locally
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");

      const filePath = join(this.config.workspace, payload.filePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, payload.content, "utf-8");

      log.info(`Memory file updated: ${payload.filePath} (${payload.content.length} bytes)`);
    } catch (err) {
      log.error(
        `Failed to apply memory broadcast for ${payload.filePath}:`,
        err as Record<string, unknown>,
      );
    }
  }

  /**
   * Receive a gateway broadcast event that master forwarded to this
   * satellite (master → satellite event.forward), and re-broadcast it on
   * the satellite's own local gateway WS. This is what makes
   * cross-device agent streaming, terminal output, and tool-call
   * progress reach UI clients connected to the satellite gateway when
   * the underlying run is happening on master.
   *
   * Master populates `payload = { event, payload }` keying off
   * runId/sessionKey owners tracked in handleMasterGatewayInvoke. We
   * just unwrap and re-emit. No filtering — master already filtered.
   */
  private handleEventForward(message: FederationMessage): void {
    const wrapped = message.payload as { event?: string; payload?: unknown } | null;
    if (!wrapped || typeof wrapped.event !== "string") {
      log.warn("[FED-RELAY] event.forward missing event field; dropping");
      return;
    }
    if (!this.localBroadcaster) {
      log.warn(
        `[FED-RELAY] event.forward received (${wrapped.event}) but no local broadcaster wired; dropping`,
      );
      return;
    }
    try {
      this.localBroadcaster.broadcast(wrapped.event, wrapped.payload);
      log.info(`[FED-RELAY] re-broadcast event=${wrapped.event} from master to local UI`);
    } catch (err) {
      log.warn(
        `[FED-RELAY] event.forward local rebroadcast failed (${wrapped.event}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Inject the local gateway broadcaster. Called once at this
   * satellite's gateway startup. Without this wired in, event.forward
   * messages from master are silently dropped (the satellite UI then
   * appears to "freeze" on cross-device runs).
   */
  setLocalBroadcaster(broadcaster: { broadcast: (event: string, payload: unknown) => void }): void {
    this.localBroadcaster = broadcaster;
  }

  /**
   * The last gateway version master reported, or null if we haven't received
   * a versioned payload yet. Used by the production updater's "match master".
   */
  getLastKnownMasterVersion(): string | null {
    return this.lastKnownMasterVersion;
  }

  /**
   * Check if satellite version is outdated and auto-update if needed.
   */
  private async checkAndAutoUpdate(masterVersion: string): Promise<void> {
    try {
      // Get local version
      const { readFile } = await import("node:fs/promises");
      const pkgPath = new URL("../../package.json", import.meta.url);
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const localVersion = pkg.version;

      if (localVersion === masterVersion) {
        log.debug(`Version ${localVersion} matches master`);
        return;
      }

      // Compare versions (simple string compare works for our format)
      if (localVersion >= masterVersion) {
        log.debug(`Local version ${localVersion} >= master ${masterVersion}, no update needed`);
        return;
      }

      log.info(`Version mismatch: local ${localVersion} < master ${masterVersion}`);
      log.info("Starting auto-update...");

      // Emit update event for external handlers
      this.emit("update:available", { localVersion, masterVersion });

      // Run npm update
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      try {
        log.info("Running: npm update -g infinibot");
        const { stdout, stderr } = await execAsync("npm update -g infinibot", {
          timeout: 120000, // 2 minute timeout
        });

        if (stdout) log.info(`npm update stdout: ${stdout.trim()}`);
        if (stderr) log.warn(`npm update stderr: ${stderr.trim()}`);

        log.info("Update complete! Restarting satellite...");
        this.emit("update:complete", { oldVersion: localVersion, newVersion: masterVersion });

        // Schedule restart after a short delay
        setTimeout(() => {
          log.info("Restarting process...");
          process.exit(0); // Exit cleanly - supervisor/pm2 should restart
        }, 2000);
      } catch (updateErr) {
        const errMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        log.error(`Auto-update failed: ${errMsg}`);
        this.emit("update:failed", { error: errMsg });
      }
    } catch (err) {
      log.warn("Could not check version for auto-update:", err as Record<string, unknown>);
    }
  }

  /**
   * Handle disconnect from master.
   */
  private handleDisconnect(reason: string): void {
    const wasConnected = this.state === "connected";

    this.stopHeartbeat();
    this.stopHardwarePush();
    this.stopFileWatcher();
    this.ws = null;

    if (wasConnected) {
      log.info(`disconnected from master: ${reason}`);
      this.emit("disconnected", reason);
      this.scheduleMasterFailover(reason);
    }

    if (!this.closed && this.config.autoReconnect) {
      this.scheduleReconnect();
    } else {
      this.setState("disconnected");
    }
  }

  /**
   * Start heartbeat timer.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    // Send initial heartbeat
    this.sendHeartbeat();
  }

  /**
   * Stop heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send heartbeat to master.
   */
  private sendHeartbeat(): void {
    if (!this.ws || this.state !== "connected") return;

    // Dead-socket watchdog. After laptop sleep or a network switch the TCP
    // connection can stay "open" for many minutes without delivering
    // anything. If no heartbeat ack arrived for 3 intervals (min 45 s), drop
    // the socket so the normal reconnect path runs.
    const staleAfter = Math.max(45_000, this.config.heartbeatIntervalMs * 3);
    const lastAlive = this.lastHeartbeatAck ?? this.connectedAt ?? Date.now();
    if (Date.now() - lastAlive > staleAfter) {
      log.warn(
        `no heartbeat ack for ${Math.round((Date.now() - lastAlive) / 1000)}s — reconnecting`,
      );
      this.lastError = {
        code: "STALE",
        message: "Lost contact with the master — reconnecting",
        at: Date.now(),
      };
      try {
        this.ws.terminate();
      } catch {
        /* close handler reconnects */
      }
      return;
    }

    // Get current load from resource monitor if available
    const metrics = this.lastMetrics;
    const loadScore = metrics?.loadScore ?? this.currentLoad;

    // Build enhanced heartbeat with detailed metrics
    const heartbeatPayload = {
      timestamp: Date.now(),
      load: loadScore,
      activeSessions: this.activeSessions,
      // Include detailed metrics for load balancing
      metrics: metrics
        ? {
            cpuPercent: metrics.cpuPercent,
            memoryPercent: metrics.memoryPercent,
            gpuPercent: metrics.gpuPercent,
            gpuMemoryPercent: metrics.gpuMemoryPercent,
            activeSessions: metrics.activeSessions,
            pendingTasks: metrics.pendingTasks,
            loadScore: metrics.loadScore,
          }
        : undefined,
    };

    const message = JSON.stringify({
      type: "node.heartbeat",
      payload: heartbeatPayload,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
    });

    try {
      this.ws.send(message);
    } catch (err) {
      log.error(`failed to send heartbeat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Start resource monitoring (call after registration).
   */
  private startResourceMonitoring(): void {
    if (this.resourceMonitor) return;

    this.resourceMonitor = initResourceMonitor(this.manifest.id, {
      metricsIntervalMs: this.config.heartbeatIntervalMs,
    });

    this.resourceMonitor.on("metrics", (metrics: NodeLoadMetrics) => {
      this.lastMetrics = metrics;
      this.currentLoad = metrics.loadScore;
      this.activeSessions = metrics.activeSessions;
    });

    this.resourceMonitor.start();
    log.info("resource monitoring started");
  }

  /**
   * Stop resource monitoring.
   */
  private stopResourceMonitoring(): void {
    if (this.resourceMonitor) {
      this.resourceMonitor.stop();
      this.resourceMonitor = null;
      log.info("resource monitoring stopped");
    }
  }

  /**
   * Start pushing full HardwareSnapshots to master at 1Hz.
   *
   * Throttle rules (HW push only — NOT a heartbeat substitute):
   *   • Min interval: 1000ms.
   *   • Max interval: 5000ms (keep-alive even when idle).
   *   • Between min and max, skip if nothing meaningful changed (≥ 2% on any axis).
   */
  private startHardwarePush(): void {
    if (this.hardwareTimer) return;
    this.lastHardwarePushAt = 0;
    this.lastHardwareSnapshot = null;
    const tick = async () => {
      if (!this.ws || this.state !== "connected") return;
      try {
        const snap = await collectHardwareSnapshot();
        const now = Date.now();
        const elapsed = now - this.lastHardwarePushAt;
        const interesting = snapshotMeaningfullyChanged(this.lastHardwareSnapshot, snap);
        // Always push if no prior push, if 5s+ elapsed (keepalive), or if state moved.
        if (this.lastHardwarePushAt !== 0 && elapsed < 5_000 && !interesting) {
          return;
        }
        const message = JSON.stringify({
          type: "hardware.snapshot" as FederationMessageType,
          payload: snap,
          nodeId: this.manifest.id,
          timestamp: now,
        });
        try {
          this.ws.send(message);
          this.lastHardwarePushAt = now;
          this.lastHardwareSnapshot = snap;
        } catch (err) {
          log.debug(
            `hardware.snapshot send failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } catch (err) {
        log.debug(
          `hardware.snapshot collect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    this.hardwareTimer = setInterval(() => {
      void tick();
    }, 1000);
    // Immediate first push so the master shows the satellite quickly.
    void tick();
    log.info("hardware snapshot push started");
  }

  private stopHardwarePush(): void {
    if (this.hardwareTimer) {
      clearInterval(this.hardwareTimer);
      this.hardwareTimer = null;
      log.info("hardware snapshot push stopped");
    }
  }

  /**
   * Start file watcher for memory sync (call after registration).
   */
  private async startFileWatcher(): Promise<void> {
    if (!this.fileWatcher) return;

    try {
      await this.fileWatcher.start();
      log.info("memory file watcher started");
    } catch (err) {
      log.error(
        `Failed to start file watcher: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Stop file watcher for memory sync.
   */
  private stopFileWatcher(): void {
    if (this.fileWatcher && this.fileWatcher.isActive()) {
      this.fileWatcher.stop();
      log.info("memory file watcher stopped");
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.closed) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      log.error("max reconnect attempts reached");
      this.setState("disconnected");
      return;
    }

    // Several addresses for the same master (Tailscale DNS, Tailscale IP,
    // LAN): if we have not reached ANY of them since start-up (e.g. the
    // laptop booted on another network), try the next one every 2 failures.
    // Once connected, losing the master is handled by the failover timer.
    if (
      this.masterUrls.length > 1 &&
      this.connectedAt === null &&
      this.reconnectAttempts % 2 === 0
    ) {
      this.currentMasterIndex = (this.currentMasterIndex + 1) % this.masterUrls.length;
      this.config.masterUrl = this.masterUrls[this.currentMasterIndex];
      log.info(`trying master address ${this.config.masterUrl}`);
    }

    // Calculate backoff delay with jitter
    const baseDelay = Math.min(
      this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelayMs,
    );
    const jitter = Math.random() * 0.3 * baseDelay;
    const delay = Math.floor(baseDelay + jitter);

    log.info(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.setState("reconnecting");

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        log.error(`reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!this.closed && this.config.autoReconnect && !this.reconnectTimer) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private scheduleMasterFailover(reason: string): void {
    if (this.masterFailoverTimer || this.closed) return;

    this.masterFailoverTimer = setTimeout(() => {
      this.masterFailoverTimer = null;
      void this.attemptMasterFailover(reason);
    }, this.config.masterFailoverTimeoutMs);
    this.masterFailoverTimer.unref();
  }

  private stopMasterFailoverTimer(): void {
    if (this.masterFailoverTimer) {
      clearTimeout(this.masterFailoverTimer);
      this.masterFailoverTimer = null;
    }
  }

  private async attemptMasterFailover(reason: string): Promise<void> {
    if (this.closed || this.state === "connected") return;

    const nextIndex = this.findNextMasterIndex();
    if (nextIndex !== null) {
      const from = this.config.masterUrl;
      const to = this.masterUrls[nextIndex];
      this.currentMasterIndex = nextIndex;
      this.config.masterUrl = to;
      this.config.masters = this.masterUrls;
      this.emitMasterSwitchAudit(from, to, reason);

      this.stopReconnectTimer();
      this.setState("reconnecting");
      try {
        await this.connect();
      } catch (err) {
        log.warn("master failover reconnect failed", {
          from,
          to,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!this.closed && this.config.autoReconnect) {
          this.scheduleReconnect();
          this.scheduleMasterFailover(reason);
        }
      }
      return;
    }

    if (this.peerMesh && this.peerMesh.getConnectedPeers().length > 0) {
      const from = this.config.masterUrl;
      this.emitMasterSwitchAudit(from, "self", reason);
      await this.handleRoleChange({
        newRole: "master",
        federationPort: this.config.peerPort,
      });
    }
  }

  private findNextMasterIndex(): number | null {
    if (this.masterUrls.length <= 1) return null;

    for (let offset = 1; offset < this.masterUrls.length; offset++) {
      const index = (this.currentMasterIndex + offset) % this.masterUrls.length;
      if (this.masterUrls[index] !== this.config.masterUrl) return index;
    }

    return null;
  }

  private emitMasterSwitchAudit(from: string, to: string, reason: string): void {
    const entry = { from, to, reason, ts: Date.now() };
    this.emit("audit-log", entry);
    this.auditLogger.logSuccess("node.connect", {
      satelliteId: this.manifest.id,
      operation: "master.switch",
      resource: `${from} -> ${to}`,
      metadata: entry,
    });
  }

  private retryPendingDeliveriesToMaster(): void {
    if (!this.ws || this.state !== "connected") return;

    const retried = this.deliveryManager.retryPendingForTarget("master", async (msg) => {
      if (!this.ws || this.state !== "connected") {
        throw new Error("WebSocket disconnected");
      }
      await sendWebSocketMessage(this.ws, JSON.stringify(msg));
    });

    if (retried > 0) {
      log.info("replayed pending federation deliveries to master", { count: retried });
    }
  }

  /**
   * Stop reconnect timer.
   */
  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopMasterFailoverTimer();
  }

  /**
   * Handle MCP invoke request from master.
   */
  private async handleMCPInvoke(message: FederationMessage): Promise<void> {
    const request = message.payload as MCPInvokeRequest;
    const messageId = message.messageId;

    log.debug(`handling MCP invoke: ${request.mcpName}.${request.tool}`);

    try {
      // Import MCP proxy and invoke locally
      const { invokeMCP } = await import("./mcp-proxy.js");
      const result = await invokeMCP(request.mcpName, request.tool, request.args, this.manifest.id);

      // Send result back to master
      this.sendMCPInvokeResult(result, messageId);
    } catch (err) {
      // Send error result back to master
      const errorResult: MCPInvokeResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        sourceNodeId: this.manifest.id,
      };
      this.sendMCPInvokeResult(errorResult, messageId);
    }
  }

  /**
   * Handle MCP list request from master.
   */
  private async handleMCPList(message: FederationMessage): Promise<void> {
    const request = message.payload as MCPListRequest;
    const messageId = message.messageId;

    log.debug(`handling MCP list request`);

    try {
      // Import MCP proxy and list local MCPs
      const { listFederationMCPs } = await import("./mcp-proxy.js");
      const result = await listFederationMCPs(this.manifest.id);

      // Send result back to master
      this.sendMCPListResult(result, messageId);
    } catch (err) {
      log.error(`MCP list failed: ${err instanceof Error ? err.message : String(err)}`);
      // Send empty result on error
      this.sendMCPListResult({ servers: [] }, messageId);
    }
  }

  /**
   * Handle MCP invoke result from master (for requests we sent).
   */
  private handleMCPInvokeResult(message: FederationMessage): void {
    const result = message.payload as MCPInvokeResult;
    const correlationId = message.correlationId;

    log.debug(`received MCP invoke result: ${result.success ? "success" : result.error}`);

    // This would resolve pending MCP invoke promises
    // For now, we just log since this implementation focuses on satellite receiving invokes
    if (correlationId && this.pendingMCPInvokes?.has(correlationId)) {
      const pending = this.pendingMCPInvokes.get(correlationId)!;
      clearTimeout(pending.timer);
      this.pendingMCPInvokes.delete(correlationId);
      pending.resolve(result);
    }
  }

  /**
   * Send MCP invoke result back to master.
   */
  private sendMCPInvokeResult(result: MCPInvokeResult, messageId?: string): void {
    if (!this.ws || this.state !== "connected") return;

    const message = JSON.stringify({
      type: "mcp.invoke.result",
      payload: result,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId: messageId,
    });

    try {
      this.ws.send(message);
      log.debug(`sent MCP invoke result: ${result.success ? "success" : result.error}`);
    } catch (err) {
      log.error(
        `failed to send MCP invoke result: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Handle delivery ACK message.
   */
  private handleDeliveryAck(message: FederationMessage): void {
    const payload = message.payload as {
      messageId: string;
      receiverId: string;
      timestamp: number;
    };

    if (typeof payload.messageId !== "string") {
      log.warn("Invalid delivery.ack payload", { payload });
      return;
    }

    log.debug("Received delivery ACK", {
      messageId: payload.messageId,
      receiverId: payload.receiverId,
    });

    // Forward to delivery manager
    this.deliveryManager.handleAck(payload.messageId);
  }

  /**
   * Send MCP list result back to master.
   */
  private sendMCPListResult(result: MCPListResult, messageId?: string): void {
    if (!this.ws || this.state !== "connected") return;

    const message = JSON.stringify({
      type: "mcp.list.result",
      payload: result,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId: messageId,
    });

    try {
      this.ws.send(message);
      log.debug(`sent MCP list result: ${result.servers.length} servers`);
    } catch (err) {
      log.error(
        `failed to send MCP list result: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build local node manifest.
   */
  private buildLocalManifest(): NodeManifest {
    const cfg = loadConfig();
    const ollamaStatus = getLastOllamaStatus();
    const nodeName = this.config.nodeName;
    const nodeId = this.config.nodeId || generateNodeId();
    const device = this.deviceCapabilities ?? collectDeviceCapabilities();
    this.deviceCapabilities = device;
    const gatewayPort = cfg.gateway?.port ?? 18789;
    const host = hostname();

    return {
      id: nodeId,
      name: nodeName,
      hostname: host,
      port: gatewayPort,
      workspace: this.config.workspace,
      capabilities: {
        // Prefer the live local Ollama status (autostarted at boot) over the
        // static config flag so peers can discover models on this node.
        hasOllama: ollamaStatus?.running ?? this.config.capabilities?.hasOllama ?? false,
        ollamaModels:
          ollamaStatus?.running && ollamaStatus.models.length > 0
            ? ollamaStatus.models
            : this.config.capabilities?.ollamaModels,
        hasComfyUI: this.config.capabilities?.hasComfyUI ?? false,
        hasVoice: this.config.capabilities?.hasVoice ?? false,
        mcpServers: this.config.capabilities?.mcpServers ?? [],
        agents: this.config.capabilities?.agents ?? (cfg.agents ? Object.keys(cfg.agents) : []),
        workspaces: [this.config.workspace],
        platform: process.platform,
        arch: process.arch,
        gpu: this.config.capabilities?.gpu ?? device.gpu?.name,
        gpuVRAM:
          this.config.capabilities?.gpuVRAM ??
          (device.gpu?.vramMB ? Math.round(device.gpu.vramMB / 1024) : undefined),
        systemRAM: this.config.capabilities?.systemRAM ?? Math.round(device.memoryMB / 1024),
        device,
      },
      isMaster: false,
      gatewayUrl: resolveGatewayUrl(cfg.federation?.publicUrl, host, gatewayPort),
    };
  }

  /**
   * Send a response to the master for a session request.
   * Uses delivery manager for guaranteed delivery.
   */
  sendSessionResult(
    type: "session.spawn.result" | "session.send.result",
    correlationId: string,
    result: {
      success: boolean;
      sessionKey?: string;
      runId?: string;
      reply?: string;
      error?: string;
    },
  ): void {
    if (!this.ws || this.state !== "connected") {
      log.warn(
        `Cannot send ${type} - not connected (state=${this.state}, ws=${!!this.ws}). correlationId=${correlationId}`,
      );
      return;
    }

    const messageData: FederationMessage = {
      type,
      payload: result,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId,
    };

    // Use delivery manager for guaranteed delivery (same as sendSessionComplete)
    this.deliveryManager.sendMessage(
      messageData,
      "master",
      async (msg) => {
        if (this.ws && this.state === "connected") {
          await sendWebSocketMessage(this.ws, JSON.stringify(msg));
        } else {
          log.warn(`WS disconnected during delivery attempt for ${type} (${correlationId})`);
          throw new Error("WebSocket disconnected");
        }
      },
      {
        onSuccess: (messageId) => {
          log.debug(`${type} delivered successfully: ${correlationId} (messageId: ${messageId})`);
        },
        onFailure: (messageId, error) => {
          log.error(
            `${type} delivery failed: ${correlationId} (messageId: ${messageId}) - ${error}`,
          );
        },
      },
    );
  }

  /**
   * Send session completion notification to master.
   */
  sendSessionComplete(
    correlationId: string,
    completion: {
      sessionKey: string;
      runId: string;
      success: boolean;
      result?: string;
      error?: string;
    },
  ): void {
    if (!this.ws || this.state !== "connected") return;

    const messageData: FederationMessage = {
      type: "session.complete",
      payload: completion,
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      correlationId,
    };

    // Use delivery manager for guaranteed delivery
    this.deliveryManager.sendMessage(
      messageData,
      "master",
      async (msg) => {
        if (this.ws && this.state === "connected") {
          await sendWebSocketMessage(this.ws, JSON.stringify(msg));
        } else {
          throw new Error("WebSocket disconnected");
        }
      },
      {
        onSuccess: (messageId) => {
          log.debug(
            `session completion delivered successfully: ${completion.sessionKey} (${correlationId})`,
          );
        },
        onFailure: (messageId, error) => {
          log.error(
            `session completion delivery failed: ${completion.sessionKey} (${correlationId}) - ${error}`,
          );
        },
      },
    );
  }

  // ===========================================================================
  // Session Migration Support
  // ===========================================================================

  /**
   * Get session state for migration.
   * This method should be called by the federation hub during session migration.
   */
  async getSessionState(
    sessionKey: string,
  ): Promise<{ success: boolean; state?: SessionState; error?: string }> {
    log.info(`getting session state for migration: ${sessionKey}`);

    try {
      // Serialize the session state
      const serializationResult = await serializeSession(sessionKey, {
        includeFullHistory: true,
        maxMessages: 1000,
        includeFileSystem: true,
      });

      log.info(`session state serialized: ${serializationResult.sizeBytes} bytes`);

      return {
        success: true,
        state: serializationResult.state,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`failed to get session state: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Create a migrated session from transferred state.
   */
  async createMigratedSession(
    sessionState: SessionState,
  ): Promise<{ success: boolean; sessionKey?: string; error?: string }> {
    log.info(`creating migrated session from state: ${sessionState.originalSessionKey}`);

    try {
      // Restore the session on this node
      const restorationResult = await restoreSession(sessionState, this.manifest.id);

      if (!restorationResult.success) {
        return {
          success: false,
          error: restorationResult.error || "Failed to restore session",
        };
      }

      log.info(`migrated session created: ${restorationResult.newSessionKey}`);

      return {
        success: true,
        sessionKey: restorationResult.newSessionKey,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`failed to create migrated session: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Cleanup a session after it has been migrated away.
   */
  async cleanupMigratedSession(
    sessionKey: string,
    reason = "migrated",
  ): Promise<{ success: boolean; error?: string }> {
    log.info(`cleaning up migrated session: ${sessionKey} (${reason})`);

    try {
      // TODO: Implement actual session cleanup
      // This would involve:
      // 1. Terminating the session if it's still active
      // 2. Cleaning up any associated resources
      // 3. Removing from local session registry

      log.info(`session cleanup completed: ${sessionKey}`);

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`failed to cleanup session: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Proxy an arbitrary gateway RPC call up to the master's gateway and await
   * its response. Used by the satellite gateway dispatcher to route business
   * (and other shared) data writes to the master — the master owns the source
   * of truth, the satellite is a pass-through for those domains.
   *
   * Returns the master's `{ success, data, error }` shape so the caller can
   * forward it back to the original UI client unchanged.
   */
  invokeOnMaster(
    method: string,
    params: Record<string, unknown> | undefined,
    // 60 s (was 30 s): a large knowledge-graph snapshot can take a few seconds
    // to build + serialize + transfer on the master before the result lands.
    timeoutMs = 60_000,
  ): Promise<{ success: boolean; data?: unknown; error?: { code?: string; message?: string } }> {
    if (!this.ws || this.state !== "connected") {
      return Promise.resolve({
        success: false,
        error: { code: "NOT_CONNECTED", message: "Satellite not connected to master" },
      });
    }

    return new Promise((resolve) => {
      const correlationId = this.generateMessageId();
      if (!this.pendingMasterInvokes) this.pendingMasterInvokes = new Map();

      const timer = setTimeout(() => {
        this.pendingMasterInvokes?.delete(correlationId);
        resolve({
          success: false,
          error: { code: "TIMEOUT", message: `master.gateway.invoke timeout (${timeoutMs}ms)` },
        });
      }, timeoutMs);

      this.pendingMasterInvokes.set(correlationId, { resolve, timer });

      try {
        this.ws!.send(
          JSON.stringify({
            type: "master.gateway.invoke",
            payload: { method, params: params ?? {} },
            nodeId: this.manifest.id,
            timestamp: Date.now(),
            messageId: correlationId,
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingMasterInvokes.delete(correlationId);
        resolve({
          success: false,
          error: {
            code: "SEND_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });
  }

  /**
   * Handle a `master.gateway.invoke.result` reply from master. Resolves the
   * pending promise stored by `invokeOnMaster` so the original RPC caller
   * gets the master's response.
   */
  private handleMasterInvokeResult(message: FederationMessage): void {
    const correlationId =
      (message as { correlationId?: string }).correlationId ??
      (message as { messageId?: string }).messageId;
    if (!correlationId || !this.pendingMasterInvokes?.has(correlationId)) {
      log.debug(`master.gateway.invoke.result with unknown correlationId: ${correlationId}`);
      return;
    }
    const pending = this.pendingMasterInvokes.get(correlationId)!;
    clearTimeout(pending.timer);
    this.pendingMasterInvokes.delete(correlationId);
    const payload =
      typeof message.payload === "object" && message.payload !== null
        ? (message.payload as Record<string, unknown>)
        : {};
    pending.resolve({
      success: payload.success === true,
      data: payload.data,
      error: (payload.error as { code?: string; message?: string } | undefined) ?? undefined,
    });
  }

  /**
   * Send an MCP invoke request to master and wait for response.
   */
  sendMCPInvokeRequest(
    mcpName: string,
    tool: string,
    args: Record<string, unknown>,
    targetNodeId?: string,
    timeoutMs = 30000,
  ): Promise<MCPInvokeResult> {
    if (!this.ws || this.state !== "connected") {
      return Promise.resolve({
        success: false,
        error: "Satellite not connected to master",
        sourceNodeId: this.manifest.id,
      });
    }

    return new Promise((resolve) => {
      const messageId = this.generateMessageId();

      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingMCPInvokes?.delete(messageId);
        resolve({
          success: false,
          error: `MCP invoke timeout (${timeoutMs}ms)`,
          sourceNodeId: this.manifest.id,
        });
      }, timeoutMs);

      // Store pending request
      if (!this.pendingMCPInvokes) {
        this.pendingMCPInvokes = new Map();
      }
      this.pendingMCPInvokes.set(messageId, {
        resolve: (result: MCPInvokeResult) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          resolve({
            success: false,
            error: error.message,
            sourceNodeId: this.manifest.id,
          });
        },
        timer,
      });

      // Send MCP invoke request to master
      const request: MCPInvokeRequest = {
        mcpName,
        tool,
        args,
        targetNodeId,
      };

      const message = JSON.stringify({
        type: "mcp.invoke",
        payload: request,
        nodeId: this.manifest.id,
        timestamp: Date.now(),
        messageId,
      });

      try {
        this.ws!.send(message);
        log.debug(`sent MCP invoke request: ${mcpName}.${tool}`);
      } catch (err) {
        clearTimeout(timer);
        this.pendingMCPInvokes.delete(messageId);
        resolve({
          success: false,
          error: `Failed to send MCP invoke: ${err instanceof Error ? err.message : String(err)}`,
          sourceNodeId: this.manifest.id,
        });
      }
    });
  }

  /**
   * Generate a unique message ID for correlation.
   */
  private generateMessageId(): string {
    return (
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    );
  }

  /**
   * Handle transcript request from master.
   */
  private handleTranscriptRequest(message: FederationMessage): void {
    const payload = message.payload as {
      sessionKey: string;
      nodeId: string;
      limit?: number;
      before?: number;
      includeTools?: boolean;
      requestId: string;
    };

    log.debug(`Handling transcript request for ${payload.sessionKey}`);

    // Import transcript sync manager
    const { getTranscriptSyncManager } = require("./transcript-sync.js");
    const syncManager = getTranscriptSyncManager();

    if (syncManager) {
      const response = syncManager.handleTranscriptRequest(payload);

      // Send response back to master
      const responseMessage = JSON.stringify({
        type: "transcript.response",
        payload: response,
        nodeId: this.manifest.id,
        timestamp: Date.now(),
      });

      try {
        this.ws?.send(responseMessage);
        log.debug(`Sent transcript response for ${payload.sessionKey}`);
      } catch (err) {
        log.error(
          `Failed to send transcript response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Send error response
      const errorResponse = {
        sessionKey: payload.sessionKey,
        requestId: payload.requestId,
        success: false,
        error: "Transcript sync manager not initialized",
        fromNodeId: this.manifest.id,
      };

      const responseMessage = JSON.stringify({
        type: "transcript.response",
        payload: errorResponse,
        nodeId: this.manifest.id,
        timestamp: Date.now(),
      });

      try {
        this.ws?.send(responseMessage);
      } catch (err) {
        log.error(
          `Failed to send transcript error response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Handle transcript response from master or other nodes.
   */
  private handleTranscriptResponse(message: FederationMessage): void {
    const payload = message.payload as {
      sessionKey: string;
      requestId: string;
      success: boolean;
      messages?: any[];
      session?: any;
      error?: string;
      fromNodeId: string;
    };

    log.debug(`Received transcript response for ${payload.sessionKey} from ${payload.fromNodeId}`);

    // Import transcript sync manager
    const { getTranscriptSyncManager } = require("./transcript-sync.js");
    const syncManager = getTranscriptSyncManager();

    if (syncManager) {
      syncManager.handleTranscriptResponse(payload);
    } else {
      log.warn("Received transcript response but sync manager not initialized");
    }
  }

  /**
   * Handle real-time transcript stream from master or other nodes.
   */
  private handleTranscriptStream(message: FederationMessage): void {
    const payload = message.payload as {
      sessionKey: string;
      message: any;
      fromNodeId: string;
    };

    log.debug(`Received transcript stream for ${payload.sessionKey} from ${payload.fromNodeId}`);

    // Import transcript sync manager
    const { getTranscriptSyncManager } = require("./transcript-sync.js");
    const syncManager = getTranscriptSyncManager();

    if (syncManager) {
      syncManager.handleStreamedMessage(payload);
    } else {
      log.warn("Received transcript stream but sync manager not initialized");
    }
  }

  // ===========================================================================
  // Peer-to-Peer Mesh Methods
  // ===========================================================================

  /**
   * Initialize peer mesh for satellite-to-satellite communication.
   */
  private async initializePeerMesh(): Promise<void> {
    if (!this.config.enablePeerMesh) {
      log.info("peer mesh disabled by configuration");
      return;
    }

    try {
      this.peerMesh = initPeerMesh({
        localManifest: this.manifest,
        peerPort: this.config.peerPort,
        maxPeerConnections: this.config.maxPeerConnections,
      });

      // Set up peer mesh event handlers
      this.peerMesh.on("peer:connected", (nodeId, manifest) => {
        log.info(`direct peer connection established: ${manifest.name} (${nodeId})`);
        this.emit("peer:connected", nodeId, manifest);
      });

      this.peerMesh.on("peer:disconnected", (nodeId, reason) => {
        log.info(`direct peer disconnected: ${nodeId} (${reason})`);
        this.emit("peer:disconnected", nodeId, reason);
      });

      this.peerMesh.on("peer:spawn:request", (nodeId, request) => {
        // Forward peer spawn requests to the same handler as hub requests
        this.emit("session:spawn:request", request);
      });

      this.peerMesh.on("peer:send:request", (nodeId, request) => {
        // Forward peer send requests to the same handler as hub requests
        this.emit("session:send:request", request);
      });

      this.peerMesh.on("error", (error) => {
        log.error("peer mesh error:", error);
        this.emit("error", error);
      });

      // Start peer mesh server
      await this.peerMesh.start();

      // Request peer discovery from hub
      this.requestPeerDiscovery();

      log.info(`peer mesh initialized on port ${this.config.peerPort}`);
    } catch (error) {
      log.error("failed to initialize peer mesh", { error });
      this.emit("error", error);
    }
  }

  /**
   * Request peer discovery from the hub.
   */
  private requestPeerDiscovery(): void {
    if (!this.ws || this.state !== "connected") {
      log.warn("cannot request peer discovery: not connected to hub");
      return;
    }

    const discoveryRequest: FederationMessage = {
      type: "peer.discovery",
      payload: {
        requestingNodeId: this.manifest.id,
        requireCapabilities: [], // Request all available peers for now
      },
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      messageId: generateMessageId(),
    };

    try {
      this.ws.send(JSON.stringify(discoveryRequest));
      log.debug("requested peer discovery from hub");
    } catch (error) {
      log.error("failed to send peer discovery request", { error });
    }
  }

  /**
   * Handle peer discovery result from hub.
   */
  private handlePeerDiscoveryResult(message: FederationMessage): void {
    const payload = message.payload as PeerDiscoveryResult;

    log.info(`received peer discovery result: ${payload.availablePeers.length} peers available`);

    if (this.peerMesh) {
      this.peerMesh.updateAvailablePeers(payload.availablePeers);
    }

    this.emit("peer:discovery", payload.availablePeers);
  }

  /**
   * Send message to peer directly (falls back to hub if direct connection unavailable).
   */
  async sendMessageToPeer(
    targetNodeId: string,
    messageType: FederationMessageType,
    payload: any,
  ): Promise<boolean> {
    // Try direct peer connection first
    if (this.peerMesh && this.peerMesh.isConnectedToPeer(targetNodeId)) {
      const success = this.peerMesh.sendMessageToPeer(targetNodeId, messageType, payload);
      if (success) {
        log.debug(`message sent directly to peer ${targetNodeId}`);
        return true;
      }
    }

    // Fall back to hub relay
    return this.sendMessageViaHub(targetNodeId, messageType, payload);
  }

  /**
   * Spawn session on peer directly (falls back to hub if direct connection unavailable).
   */
  async spawnSessionOnPeer(nodeId: string, request: SessionSpawnRequest): Promise<SessionHandle> {
    // Try direct peer connection first
    if (this.peerMesh && this.peerMesh.isConnectedToPeer(nodeId)) {
      try {
        const result = await this.peerMesh.spawnSessionOnPeer(nodeId, request);
        log.info(`session spawned directly on peer ${nodeId}: ${result.sessionKey}`);
        return result;
      } catch (error) {
        log.warn(`direct spawn on peer ${nodeId} failed, falling back to hub`, { error });
      }
    }

    // Fall back to hub relay
    return this.spawnSessionViaHub(nodeId, request);
  }

  /**
   * Send message via hub relay (existing hub-spoke behavior).
   */
  private async sendMessageViaHub(
    targetNodeId: string,
    messageType: FederationMessageType,
    payload: any,
  ): Promise<boolean> {
    if (!this.ws || this.state !== "connected") {
      throw new Error("Not connected to hub");
    }

    const message: FederationMessage = {
      type: messageType,
      payload: {
        ...payload,
        targetNodeId,
      },
      nodeId: this.manifest.id,
      timestamp: Date.now(),
      messageId: generateMessageId(),
    };

    try {
      this.ws.send(JSON.stringify(message));
      log.debug(`message sent to ${targetNodeId} via hub relay`);
      return true;
    } catch (error) {
      log.error("failed to send message via hub", { error });
      return false;
    }
  }

  /**
   * Spawn session via hub relay (existing hub-spoke behavior).
   */
  private async spawnSessionViaHub(
    nodeId: string,
    request: SessionSpawnRequest,
  ): Promise<SessionHandle> {
    if (!this.ws || this.state !== "connected") {
      throw new Error("Not connected to hub");
    }

    const requestId = generateMessageId();
    request.nodeId = nodeId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Hub spawn request timeout"));
      }, 30000);

      // Set up response handler (would need to be implemented in handleMessage)
      const handleResponse = (response: any) => {
        clearTimeout(timeout);
        if (response.success) {
          resolve({
            nodeId: response.nodeId,
            sessionKey: response.sessionKey,
            runId: response.runId,
          });
        } else {
          reject(new Error(response.error || "Spawn failed"));
        }
      };

      // Send spawn request via hub
      const message: FederationMessage = {
        type: "session.spawn",
        payload: { ...request, correlationId: requestId },
        nodeId: this.manifest.id,
        timestamp: Date.now(),
        messageId: requestId,
      };

      try {
        this.ws!.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Get connected peers from mesh.
   */
  getConnectedPeers(): PeerConnection[] {
    return this.peerMesh?.getConnectedPeers() || [];
  }

  /**
   * Check if directly connected to a peer.
   */
  isDirectlyConnectedToPeer(nodeId: string): boolean {
    return this.peerMesh?.isConnectedToPeer(nodeId) || false;
  }

  /**
   * Stop peer mesh on disconnect.
   */
  private async stopPeerMesh(): Promise<void> {
    if (this.peerMesh) {
      await this.peerMesh.stop();
      this.peerMesh = null;
      log.info("peer mesh stopped");
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let defaultSatellite: FederationSatellite | null = null;

/**
 * Register an externally-constructed satellite as the process-wide
 * singleton. Used by the CLI satellite-mode path so that downstream code
 * (e.g. server-runtime-state's satellite init) can detect a satellite is
 * already running and skip a duplicate creation. Calling with `null`
 * clears the singleton on teardown.
 */
export function setFederationSatellite(satellite: FederationSatellite | null): void {
  defaultSatellite = satellite;
}

/**
 * Get the default satellite instance.
 */
export function getFederationSatellite(): FederationSatellite | null {
  return defaultSatellite;
}

/**
 * Initialize and connect a satellite.
 */
export async function connectSatellite(config: SatelliteConfig): Promise<FederationSatellite> {
  if (defaultSatellite) {
    log.warn("satellite already initialized, disconnecting existing");
    await defaultSatellite.disconnect();
  }

  defaultSatellite = new FederationSatellite(config);
  // Attach a no-op-ish error listener BEFORE connect() so a ws-level error
  // (ETIMEDOUT, ECONNREFUSED, etc.) doesn't crash the gateway. The
  // FederationSatellite re-emits ws errors on itself, and Node's
  // EventEmitter throws on "error" when no listener is attached. The
  // calling code (federation.connect / runtime startup) catches connect()'s
  // rejection separately — this just keeps the emit harmless.
  defaultSatellite.on("error", (err: Error) => {
    log.warn(`satellite error: ${err?.message ?? String(err)}`);
  });
  try {
    await defaultSatellite.connect();
  } catch (err) {
    // Tear down the singleton on connect failure so the next caller starts
    // fresh instead of inheriting a half-initialised instance.
    try {
      await defaultSatellite.disconnect();
    } catch {
      /* shutdown errors are non-fatal */
    }
    defaultSatellite = null;
    throw err;
  }
  return defaultSatellite;
}

/**
 * Disconnect the default satellite.
 */
export async function disconnectSatellite(): Promise<void> {
  if (defaultSatellite) {
    await defaultSatellite.disconnect();
    defaultSatellite = null;
  }
}

/**
 * Create a satellite from federation config.
 */
export function createSatelliteFromConfig(
  federationConfig: FederationConfig,
): SatelliteConfig | null {
  if (
    federationConfig.mode !== "satellite" ||
    (!federationConfig.masterUrl && !federationConfig.masters?.length)
  ) {
    return null;
  }

  return {
    masterUrl: federationConfig.masterUrl,
    masters: federationConfig.masters,
    masterFailoverTimeoutMs: federationConfig.masterFailoverTimeoutMs,
    nodeName: federationConfig.nodeName,
    capabilities: federationConfig.capabilities,
    autoReconnect: true,
  };
}

/**
 * Validate a branch name received in a federation `system.update` request.
 * Accepts ordinary git ref names only; rejects anything shell- or
 * option-shaped. Missing → "main".
 */
export function normalizeUpdateBranch(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "main";
  if (typeof raw !== "string") throw new Error("system.update: branch must be a string");
  const branch = raw.trim();
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock") &&
    !branch.endsWith(".");
  if (!valid) throw new Error(`system.update: invalid branch name ${JSON.stringify(raw)}`);
  return branch;
}

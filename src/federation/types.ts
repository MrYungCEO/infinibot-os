/**
 * Federation Types
 *
 * Type definitions for the InfiniBot Federation system.
 */

// Re-export session state types for convenience
export type {
  AgentConfiguration,
  ConversationMessage,
  TaskState,
  SessionMemory,
  SessionState,
  SerializationOptions,
  SerializationResult,
  RestorationResult,
} from "../agents/session-state.js";

// ============================================================
// Task and Compute Requirements
// ============================================================

export type ComputeIntensity = "light" | "medium" | "heavy";

// ============================================================
// Capability-Based Routing Types
// ============================================================

/**
 * Standard capabilities that can be required for spawns.
 */
export type RequiredCapability =
  | "gpu" // GPU acceleration (image gen, ML)
  | "ollama" // Ollama LLM inference
  | "voice" // Voice/audio processing
  | "comfyui" // ComfyUI image generation
  | "ffmpeg" // Video/audio processing
  | "workspace" // Specific workspace access
  | string; // Custom MCP server names

/**
 * Capability requirements for a spawn request.
 */
export interface CapabilityRequirements {
  /** Hard requirements - node MUST have these capabilities */
  required: RequiredCapability[];
  /** Soft preferences - node SHOULD have these capabilities (scoring bonus) */
  preferred?: RequiredCapability[];
  /** Minimum GPU VRAM in GB (if GPU required) */
  minGpuVRAM?: number;
  /** Specific workspace path required */
  workspace?: string;
  /** Preferred node by ID or name */
  preferNode?: string;
}

/**
 * Scoring breakdown for capability-based routing transparency.
 */
export interface CapabilityScore {
  /** Base score for available capabilities */
  baseScore: number;
  /** Bonus for meeting hard requirements */
  requirementBonus: number;
  /** Bonus for meeting soft preferences */
  preferenceBonus: number;
  /** Penalty for high load */
  loadPenalty: number;
  /** Bonus/penalty for node preference */
  nodePenalty: number;
  /** Final computed score */
  finalScore: number;
  /** Capabilities this node is missing */
  missingCapabilities: RequiredCapability[];
  /** Reason for score/selection */
  reason: string;
}

export interface ComputeRequirements {
  /** Task needs GPU acceleration (image gen, ML inference) */
  needsGPU: boolean;
  /** Minimum GPU VRAM in GB, if GPU is needed */
  gpuVRAM?: number;
  /** Task needs Ollama LLM inference */
  needsOllama: boolean;
  /** Task needs voice/audio processing (LiveKit, ElevenLabs) */
  needsVoice: boolean;
  /** Task needs specific MCP servers */
  needsMCP: string[];
  /** Task needs access to local files on a specific node */
  needsLocalFiles: boolean;
  /** Specific workspace path required */
  workspace?: string;
  /** Overall compute intensity estimate */
  computeIntensity: ComputeIntensity;
  /** Estimated memory requirement in MB */
  estimatedMemoryMB?: number;
  /** Task should prefer a specific node by id or name */
  preferNode?: string;
}

export interface Task {
  /** Unique task identifier */
  id: string;
  /** Task type/category */
  type: TaskType;
  /** Task description/prompt */
  description: string;
  /** Agent that should handle this task */
  agentId?: string;
  /** Source node that created this task */
  sourceNodeId?: string;
  /** Workspace path context */
  workspace?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export type TaskType =
  | "chat"
  | "code"
  | "image_gen"
  | "voice"
  | "research"
  | "file_ops"
  | "browser"
  | "mcp_invoke"
  | "ollama_inference"
  | "subagent"
  | "unknown";

export interface FederationMessage<T = unknown> {
  type: FederationMessageType | string;
  payload: T;
  nodeId: string;
  timestamp: number;
  messageId?: string;
  correlationId?: string;
}

export type FederationMessageType =
  | "node.register"
  | "node.register.ack"
  | "node.heartbeat"
  | "node.heartbeat.ack"
  | "node.capabilities"
  | "node.disconnect"
  | "session.spawn"
  | "session.spawn.result"
  | "session.send"
  | "session.send.result"
  | "session.complete"
  | "session.event"
  | "session.event.notify"
  | "session.getState"
  | "session.getState.result"
  | "session.createMigrated"
  | "session.createMigrated.result"
  | "session.cleanup"
  | "session.cleanup.result"
  | "state.sync"
  | "state.sync.ack"
  | "state.sync.push"
  | "state.sync.pull"
  | "state.sync.full"
  | "state.update"
  | "compute.route"
  | "compute.route.result"
  | "compute.status"
  | "mcp.list"
  | "mcp.list.result"
  | "mcp.invoke"
  | "mcp.invoke.result"
  | "delivery.ack"
  | "federation.event"
  | "identity.sync"
  | "identity.sync.ack"
  | "identity.sync.request"
  | "transcript.request"
  | "transcript.response"
  | "transcript.stream"
  | "peer.discovery"
  | "peer.discovery.result"
  | "peer.handshake"
  | "peer.handshake.ack"
  | "peer.ping"
  | "peer.pong"
  | "peer.session.spawn"
  | "peer.session.send"
  | "peer.session.result"
  | "peer.route.direct"
  | "memory.update"
  | "memory.update.ack"
  | "memory.broadcast"
  | "memory.conflict"
  | "memory.request"
  | "federation.batch"
  | "federation.compressed"
  | "system.update"
  | "system.update.result"
  // Satellite → master: full HardwareSnapshot push, 1Hz (throttled by
  // hardware-collector.snapshotMeaningfullyChanged).
  | "hardware.snapshot"
  // Generic gateway-RPC proxy + reverse event-broadcast channel used for
  // cross-device PTY streaming (terminal.create / terminal.write etc on the
  // satellite, terminal.output forwarded back to master).
  | "gateway.proxy.invoke"
  | "gateway.proxy.invoke.result"
  | "gateway.proxy.invoke.stream"
  | "gateway.proxy.invoke.stream.cancel"
  // Reverse channel: satellite proxies an RPC up to master so master's
  // authoritative gateway handles it. Used for business/CRM domains where
  // master owns the data and satellites should be thin clients.
  | "master.gateway.invoke"
  | "master.gateway.invoke.result"
  | "event.broadcast"
  | "event.forward"
  | "file-transfer.start"
  | "file-transfer.chunk"
  | "file-transfer.chunk.ack"
  | "file-transfer.complete"
  | "file-transfer.error"
  | "file-transfer.pause"
  | "file-transfer.resume"
  | "role.change"
  | "error";

/** Payload for role.change — master tells satellite to take over as master */
export interface RoleChangePayload {
  /** The new role for the receiving node */
  newRole: "master";
  /** The old master's (sender's) URL so the demoted node can reconnect as satellite */
  newMasterUrl?: string;
  /** Federation port the new master should listen on */
  federationPort?: number;
}

export interface SessionSpawnRequest {
  nodeId: string;
  agentId: string;
  task: string;
  workspace?: string;
  label?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  metadata?: Record<string, unknown>;
  // Additional fields for mesh spawning
  parentSession?: string;
  capabilities?: string[];
  canSpawn?: boolean;
  timeout?: number;
  // Capability-based routing fields
  requiredCapabilities?: RequiredCapability[];
  preferredCapabilities?: RequiredCapability[];
  minGpuVRAM?: number;
}

export interface SessionSendRequest {
  nodeId: string;
  sessionKey: string;
  message: string;
  timeoutSeconds?: number;
}

export interface SessionHandle {
  nodeId: string;
  sessionKey: string;
  runId: string;
}

export interface StateSyncPayload {
  version: number;
  nodes: NodeManifest[];
  timestamp: number;
}

export interface StateUpdate {
  version: number;
  nodeId: string;
  updates: Array<{
    type: "load" | "sessions" | "capabilities";
    value: any;
  }>;
  timestamp: number;
}

export interface ComputeRouteResult {
  nodeId: string;
  reason: string;
  confidence: number;
}

export interface ComputeStatus {
  nodes: Array<{
    id: string;
    load: number;
    activeSessions: number;
    lastSeenMs: number;
  }>;
}

export enum FederationErrorCode {
  INVALID_MESSAGE = "INVALID_MESSAGE",
  SCHEMA_ERROR = "SCHEMA_ERROR",
  NODE_NOT_FOUND = "NODE_NOT_FOUND",
  NODE_OFFLINE = "NODE_OFFLINE",
  PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH",
  UNAUTHORIZED = "UNAUTHORIZED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  TIMEOUT = "TIMEOUT",
}

export class FederationError extends Error {
  constructor(
    public code: FederationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

// ============================================================
// Node Capabilities and Selection
// ============================================================

export interface NodeCapabilities {
  /** Node has Ollama server running */
  hasOllama: boolean;
  /** Ollama models available on this node */
  ollamaModels?: string[];
  /** Node has ComfyUI/ImageGen capability */
  hasComfyUI: boolean;
  /** ComfyUI installation path (if installed but not running) */
  comfyUIPath?: string;
  /** Node has voice processing (LiveKit, TTS) */
  hasVoice: boolean;
  /** Available GPU model (e.g., "RTX 5090", "M2 Max") */
  gpu?: string;
  /** GPU VRAM in GB */
  gpuVRAM?: number;
  /** System RAM in GB */
  systemRAM?: number;
  /** MCP servers available on this node */
  mcpServers: string[];
  /** Agent configurations available */
  agents: string[];
  /** Available workspaces (paths) */
  workspaces: string[];
  /** Platform (windows, darwin, linux) */
  platform?: string;
  /** Architecture (x64, arm64) */
  arch?: string;
  /** Device details + actionable features (satellites; see device-capabilities.ts). */
  device?: import("./device-capabilities.js").DeviceCapabilities;

  // ── Media Processing Capabilities ──
  /** FFmpeg available and version */
  ffmpeg?: {
    available: boolean;
    version?: string;
    hasNvenc: boolean;
    hasNvdec: boolean;
    hasCuda: boolean;
    codecs: string[];
  };
  /** Image processing tools */
  imageTools?: {
    rembg: boolean;
    realesrgan: boolean;
    pillow: boolean;
    imagemagick: boolean;
  };
  /** Media services this node can provide to federation */
  mediaServices?: string[];
}

export interface NodeManifest {
  /** Unique node identifier */
  id: string;
  /** Human-friendly name */
  name: string;
  /** Hostname or IP */
  hostname: string;
  /** Gateway WebSocket port */
  port: number;
  /** Primary workspace path on this node */
  workspace: string;
  /** Node capabilities */
  capabilities: NodeCapabilities;
  /** Whether this is the master node */
  isMaster: boolean;
  /** Last seen timestamp */
  lastSeenMs?: number;
  /** Current load (0-100) */
  currentLoad?: number;
  /** Number of active sessions */
  activeSessions?: number;
  /**
   * Externally-reachable federation WebSocket URL (e.g.
   * `ws://192.168.1.110:18789/federation`). Satellites advertise this so
   * masters / mobile clients can reach the satellite's own gateway for
   * direct HTTP work (voice, TTS, file fetch) instead of routing
   * everything through the master.
   */
  gatewayUrl?: string;
}

export interface NodeSelection {
  /** Selected node identifier */
  nodeId: string;
  /** Human-readable selection reason */
  reason: string;
  /** Confidence in selection (0-1) */
  confidence: number;
  /** Alternative nodes considered */
  alternatives?: Array<{ nodeId: string; reason: string }>;
  /** Requirements that drove this selection */
  matchedRequirements?: string[];
}

// ============================================================
// Routing Events and State
// ============================================================

/**
 * Alternative node that was considered during routing.
 */
export interface AlternativeNode {
  /** Node identifier */
  nodeId: string;
  /** Node display name */
  nodeName?: string;
  /** Score for this node (0-100+) */
  score: number;
  /** Capabilities this node is missing for the task */
  missingCapabilities: string[];
  /** Why this node wasn't selected */
  reason?: string;
}

/**
 * Enhanced routing decision with detailed reasoning.
 * Used for capability-aware auto-routing.
 */
export interface EnhancedRoutingDecision {
  /** Selected node identifier */
  nodeId: string;
  /** Node display name */
  nodeName: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Human-readable reason for selection */
  reason: string;
  /** Alternative nodes that were considered */
  alternativeNodes: AlternativeNode[];
  /** Requirements that were analyzed */
  requirements: ComputeRequirements;
  /** Whether the selection was auto-routed or explicit */
  autoRouted: boolean;
  /** Score breakdown for transparency */
  scoreBreakdown?: {
    baseScore: number;
    gpuBonus: number;
    loadPenalty: number;
    preferenceBonus: number;
    mcpPenalty: number;
    healthBonus: number;
    finalScore: number;
  };
}

export interface RoutingDecision {
  taskId: string;
  requirements: ComputeRequirements;
  selection: NodeSelection;
  timestamp: number;
  durationMs: number;
  /** Enhanced decision data (when using capability-aware routing) */
  enhanced?: EnhancedRoutingDecision;
}

export interface RoutingMetrics {
  totalDecisions: number;
  byNode: Record<string, number>;
  byReason: Record<string, number>;
  avgDecisionMs: number;
}

// ============================================================
// Load Balancing and Migration Types
// ============================================================

/** Load metrics for a federation node */
export interface NodeLoadMetrics {
  /** Node identifier */
  nodeId: string;
  /** Timestamp when metrics were collected */
  timestamp: number;
  /** CPU utilization percentage (0-100) */
  cpuPercent: number;
  /** Memory utilization percentage (0-100) */
  memoryPercent: number;
  /** GPU utilization percentage (0-100), if available */
  gpuPercent?: number;
  /** GPU memory utilization percentage (0-100), if available */
  gpuMemoryPercent?: number;
  /** Number of active sessions on this node */
  activeSessions: number;
  /** Number of pending tasks waiting to be processed */
  pendingTasks: number;
  /** Composite load score (0-100, higher = more loaded) */
  loadScore: number;
}

/** Request to migrate a session to another node */
export interface MigrationRequest {
  /** Session key to migrate */
  sessionKey: string;
  /** Node the session is currently on */
  sourceNodeId: string;
  /** Target node to migrate to */
  targetNodeId: string;
  /** Human-readable reason for migration */
  reason: string;
  /** Migration priority */
  priority: "low" | "normal" | "high";
}

/** Result of a migration attempt */
export interface MigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** New session key on target node (if successful) */
  newSessionKey?: string;
  /** Error message if migration failed */
  error?: string;
  /** Time taken for migration in milliseconds */
  durationMs: number;
}

/** Load balancer configuration options */
export interface LoadBalancerConfig {
  /** Load score threshold above which a node is considered overloaded (default: 80) */
  overloadThreshold?: number;
  /** Minimum load difference to suggest migration (default: 20) */
  migrationThreshold?: number;
  /** How often to collect metrics in ms (default: 15000) */
  metricsIntervalMs?: number;
  /** How long before metrics are considered stale in ms (default: 60000) */
  metricsStaleMs?: number;
  /** Weight factors for load score calculation */
  weights?: {
    cpu?: number;
    memory?: number;
    gpu?: number;
    sessions?: number;
    pending?: number;
  };
}

/** Fleet-wide health summary */
export interface FleetHealthSummary {
  /** Total nodes in federation */
  totalNodes: number;
  /** Nodes currently online */
  onlineNodes: number;
  /** Nodes with recent metrics */
  reportingNodes: number;
  /** Average load across all nodes */
  averageLoad: number;
  /** Number of nodes considered overloaded */
  overloadedNodes: number;
  /** Total active sessions across fleet */
  totalActiveSessions: number;
  /** Per-node metrics */
  nodeMetrics: NodeLoadMetrics[];
  /** Suggested migrations */
  suggestedMigrations: MigrationRequest[];
  /** Timestamp of this summary */
  timestamp: number;
}

// ============================================================
// Discovery Types
// ============================================================

export interface DiscoveredNode {
  /** Node identifier */
  id: string;
  /** Human-friendly name */
  name: string;
  /** IP address */
  address: string;
  /** Gateway port */
  port: number;
  /** Whether this is a master node */
  isMaster: boolean;
  /** Discovery source */
  discoveredVia: "mdns" | "manual" | "config";
  /** TXT record data from mDNS */
  txtData?: Record<string, string>;
  /** When this node was discovered */
  discoveredAtMs: number;
  /** Last time we heard from this node */
  lastAnnouncementMs: number;
}

export interface DiscoveryConfig {
  /** Enable mDNS discovery */
  mdnsEnabled: boolean;
  /** Service type for mDNS (default: _infinibot-gateway._tcp) */
  serviceType: string;
  /** How often to re-broadcast presence (ms) */
  announceIntervalMs: number;
  /** How long before a node is considered stale (ms) */
  staleThresholdMs: number;
}

// ============================================================
// Federation Configuration
// ============================================================

export type FederationMode = "master" | "satellite" | "standalone";

// ============================================================
// State Synchronization Types
// ============================================================

/**
 * Types of resources that can be synchronized across federation nodes.
 */
export type SyncableResource = "memory" | "kanban" | "transcript" | "config" | "session";

/**
 * Message types for state synchronization.
 */
export type StateSyncMessageType =
  | "state.sync.push"
  | "state.sync.pull"
  | "state.sync.ack"
  | "state.sync.full";

/**
 * Message for state synchronization between nodes.
 */
export interface StateSyncMessage {
  /** Message type */
  type: StateSyncMessageType;
  /** Resource being synchronized */
  resource: SyncableResource;
  /** Path within the resource (e.g., "memory/MEMORY.md" or "kanban/tasks/abc123") */
  path: string;
  /** Vector clock for causality tracking */
  vectorClock: Record<string, number>;
  /** The data being synchronized (for push messages) */
  data?: unknown;
  /** Node that originated this message */
  nodeId: string;
  /** Timestamp when this message was created */
  timestamp: number;
  /** Correlation ID for request/response matching */
  correlationId?: string;
}

/**
 * Represents a conflict between local and remote versions.
 */
export interface SyncConflict {
  /** Resource type */
  resource: SyncableResource;
  /** Path to the conflicting resource */
  path: string;
  /** Local version of the data */
  localVersion: unknown;
  /** Remote version of the data */
  remoteVersion: unknown;
  /** Local vector clock */
  localClock: Record<string, number>;
  /** Remote vector clock */
  remoteClock: Record<string, number>;
  /** How the conflict was resolved */
  resolution: "local" | "remote" | "merge";
  /** The merged result (if resolution is "merge") */
  mergedValue?: unknown;
}

/**
 * Configuration for state synchronization.
 */
export interface StateSyncConfig {
  /** Enable automatic sync on file changes */
  autoSync: boolean;
  /** Sync interval in milliseconds (for periodic sync) */
  syncIntervalMs: number;
  /** Resources to sync */
  resources: SyncableResource[];
  /** Conflict resolution strategy */
  conflictResolution: "last-write-wins" | "manual" | "merge";
  /** Paths to exclude from sync */
  excludePaths?: string[];
}

/**
 * State of a synchronized resource.
 */
export interface SyncedResourceState {
  /** Resource type */
  resource: SyncableResource;
  /** Path */
  path: string;
  /** Current vector clock */
  vectorClock: Record<string, number>;
  /** Last sync timestamp */
  lastSyncTimestamp: number;
  /** Whether there are pending local changes */
  pendingChanges: boolean;
  /** Content hash for change detection */
  contentHash?: string;
}

/**
 * Full sync state for a node.
 */
export interface NodeSyncState {
  /** Node ID */
  nodeId: string;
  /** All synced resources */
  resources: SyncedResourceState[];
  /** Global vector clock */
  globalClock: Record<string, number>;
  /** Last full sync timestamp */
  lastFullSyncTimestamp: number;
}

export interface FederationConfig {
  /** Whether federation is enabled */
  enabled?: boolean;
  /** Federation mode for this node */
  mode: FederationMode;
  /** Unique node identifier (auto-generated if not set) */
  nodeId?: string;
  /** Master URL for satellite mode */
  masterUrl?: string;
  /** Ordered master URLs for satellite failover, primary first */
  masters?: string[];
  /** Time to wait before switching masters after disconnect (default: 30000) */
  masterFailoverTimeoutMs?: number;
  /** Display name for this node */
  nodeName?: string;
  /** Federation port (default: 47913) */
  federationPort?: number;
  /** Enable mDNS discovery/advertising */
  discovery?: boolean;
  /**
   * When true (master mode), satellites must present a valid signed
   * registration token to join the federation; tokenless registrations are
   * rejected. Default: true when unset — a tokenless node would otherwise be
   * granted "full" permission. Set false explicitly to accept legacy tokenless
   * satellites. Setting it to true explicitly also attaches a `security`
   * payload to the register-ack.
   */
  requireRegisterToken?: boolean;
  /** Capabilities to advertise */
  capabilities?: Partial<NodeCapabilities>;
  /** What to delegate to master */
  delegate?: Array<"ollama" | "voice" | "imageGen" | "mcp">;
  /**
   * Externally-reachable URL for this node's gateway, advertised to the
   * master in the satellite's manifest (e.g.
   * `ws://my-laptop.local:18789/federation` or
   * `https://node-a.example.com/federation`). When set, mobile and other
   * clients can reach this satellite's voice / TTS endpoints directly
   * instead of falling back to the local gateway. Use this when the
   * satellite is behind NAT, a reverse proxy, or simply has an OS
   * hostname that isn't resolvable from the rest of the federation.
   */
  publicUrl?: string;
  /** Free-form human label set by `infinibot federation join` from an invite. */
  label?: string;
  /**
   * Signed satellite token persisted from a `FederationInvite`. Typed as
   * `unknown`-ish to avoid a circular import with `security.ts`; the satellite
   * cast-validates this at connect time.
   */
  authToken?: unknown;
  /**
   * Satellite only: what the master may use on this machine (terminals,
   * coder CLIs, agent runs, local compute). Unset categories stay shared.
   * See src/federation/share-policy.ts.
   */
  share?: import("./share-policy.js").FederationShare;
}

// ============================================================
// MCP Proxy Types
// ============================================================

/** MCP server status */
export type MCPServerStatus = "running" | "stopped" | "unknown";

/** Information about an MCP server available in the federation */
export interface MCPServerInfo {
  /** MCP server name */
  name: string;
  /** Node ID that hosts this MCP */
  nodeId: string;
  /** Human-friendly node name */
  nodeName: string;
  /** Tools available on this MCP server */
  tools: string[];
  /** Current server status */
  status: MCPServerStatus;
  /** Optional description */
  description?: string;
}

/** Request to list available MCPs */
export interface MCPListRequest {
  /** Optionally filter by node ID */
  nodeId?: string;
}

/** Result of MCP list request */
export interface MCPListResult {
  /** Available MCP servers */
  servers: MCPServerInfo[];
}

/** Request to invoke an MCP tool */
export interface MCPInvokeRequest {
  /** Name of the MCP server */
  mcpName: string;
  /** Tool to invoke */
  tool: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
  /** Target node ID (if not specified, find node that has this MCP) */
  targetNodeId?: string;
}

/** Result of MCP invocation */
export interface MCPInvokeResult {
  /** Whether the invocation succeeded */
  success: boolean;
  /** Result data from the MCP tool */
  result?: unknown;
  /** Error message if failed */
  error?: string;
  /** Node ID that processed the request */
  sourceNodeId: string;
}

// ============================================================
// Retry Logic Types
// ============================================================

/** Retry configuration for failed spawn operations */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs: number;
  /** Maximum delay between retries in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
}

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

// ============================================================
// Peer-to-Peer Communication Types
// ============================================================

/** Peer discovery request - satellites ask hub for other satellites */
export interface PeerDiscoveryRequest {
  /** Node requesting peer discovery */
  requestingNodeId: string;
  /** Optional filter by capability */
  requireCapabilities?: RequiredCapability[];
}

/** Peer discovery result - hub responds with available satellites */
export interface PeerDiscoveryResult {
  /** Available peer nodes for direct connection */
  availablePeers: NodeManifest[];
  /** Timestamp of this discovery result */
  timestamp: number;
}

/** Peer handshake payload for direct connections */
export interface PeerHandshakePayload {
  /** Node ID initiating handshake */
  nodeId: string;
  /** Human-friendly node name */
  nodeName: string;
  /** Protocol version for P2P communication */
  protocolVersion: number;
  /** Node capabilities advertised to peer */
  capabilities: string[];
  /** Workspace path */
  workspace?: string;
}

/** Peer handshake acknowledgment */
export interface PeerHandshakeAckPayload {
  /** Responding node ID */
  nodeId: string;
  /** Responding node name */
  nodeName: string;
  /** Whether handshake was accepted */
  accepted: boolean;
  /** Reason if rejected */
  reason?: string;
}

/** Peer routing decision - which path to use */
export interface PeerRoutingDecision {
  /** Target node ID */
  targetNodeId: string;
  /** Whether to route directly or via hub */
  routeDirect: boolean;
  /** Reason for routing decision */
  reason: string;
  /** Fallback route if direct fails */
  fallbackToHub: boolean;
}

/** Direct peer message wrapper */
export interface DirectPeerMessage<T = unknown> {
  /** Original federation message */
  originalMessage: FederationMessage<T>;
  /** Routing decision that led to this direct send */
  routingDecision: PeerRoutingDecision;
  /** Whether this is a fallback after direct failure */
  isFallback?: boolean;
}

/** Types of spawn failure that trigger different retry strategies */
export type SpawnFailureType =
  | "connection_timeout" // Retry on same or different node
  | "node_disconnected" // Retry on different node only
  | "send_failed" // Retry on same or different node
  | "agent_spawn_error" // Don't retry (user error)
  | "unknown_error"; // Retry with caution

/** Retry attempt information */
export interface RetryAttempt {
  /** Request ID being retried */
  requestId: string;
  /** Original spawn request */
  originalRequest: SessionSpawnRequest;
  /** Current attempt number (1-based) */
  attemptNumber: number;
  /** Timestamp of this attempt */
  timestamp: number;
  /** Node ID for this attempt (may differ from original) */
  targetNodeId: string;
  /** Reason for the retry */
  retryReason: SpawnFailureType;
  /** Delay before this attempt (ms) */
  delayMs: number;
}

/** Retry queue entry */
export interface RetryQueueEntry {
  /** Unique retry ID */
  retryId: string;
  /** Original request that failed */
  originalRequest: SessionSpawnRequest;
  /** Promise resolve function to call when done */
  resolve: (result: SessionHandle) => void;
  /** Promise reject function to call on final failure */
  reject: (error: Error) => void;
  /** Current attempt number */
  attemptNumber: number;
  /** Next retry timestamp */
  nextRetryAt: number;
  /** Failure type that triggered this retry */
  failureType: SpawnFailureType;
  /** Nodes to avoid on retry (already failed) */
  excludedNodes: Set<string>;
  /** Retry configuration for this entry */
  config: RetryConfig;
}

// ============================================================
// Task Queuing Types
// ============================================================

/** Priority levels for queued tasks */
export type QueuePriority = "critical" | "high" | "normal" | "low";

/** Queue item representing a pending spawn request */
export interface QueueItem {
  /** Unique queue item identifier */
  id: string;
  /** Original spawn request */
  request: SessionSpawnRequest;
  /** Priority level */
  priority: QueuePriority;
  /** Timestamp when queued */
  queuedAt: number;
  /** Timeout in milliseconds (fail if not started within this time) */
  timeoutMs: number;
  /** Promise resolve function */
  resolve: (result: SessionHandle) => void;
  /** Promise reject function */
  reject: (error: Error) => void;
  /** Current position in queue (1-based, updated when queue changes) */
  position?: number;
  /** Estimated wait time in milliseconds */
  estimatedWaitMs?: number;
}

/** Node-specific queue with priority support */
export interface NodeQueue {
  /** Target node ID */
  nodeId: string;
  /** Priority queues (critical, high, normal, low) */
  queues: {
    critical: QueueItem[];
    high: QueueItem[];
    normal: QueueItem[];
    low: QueueItem[];
  };
  /** Total items across all priority levels */
  totalItems: number;
  /** Maximum queue size (prevents unbounded growth) */
  maxSize: number;
  /** Current capacity usage of the node (0-100) */
  currentCapacity: number;
  /** Maximum allowed capacity before queuing (default: 80) */
  capacityThreshold: number;
}

/** Configuration for the task queue system */
export interface TaskQueueConfig {
  /** Maximum queue size per node (default: 100) */
  maxQueueSizePerNode?: number;
  /** Default timeout for queued items in milliseconds (default: 300000 = 5 minutes) */
  defaultTimeoutMs?: number;
  /** Capacity threshold above which tasks get queued (default: 80) */
  capacityThreshold?: number;
  /** How often to check for queue processing opportunities in ms (default: 5000) */
  processingIntervalMs?: number;
  /** Priority weights for queue processing (higher = more likely to be processed first) */
  priorityWeights?: {
    critical: number;
    high: number;
    normal: number;
    low: number;
  };
}

/** Default task queue configuration */
export const DEFAULT_TASK_QUEUE_CONFIG: TaskQueueConfig = {
  maxQueueSizePerNode: 100,
  defaultTimeoutMs: 300000, // 5 minutes
  capacityThreshold: 80,
  processingIntervalMs: 5000,
  priorityWeights: {
    critical: 1000,
    high: 100,
    normal: 10,
    low: 1,
  },
};

/** Queue statistics for monitoring */
export interface QueueStats {
  /** Total items across all nodes */
  totalItems: number;
  /** Items by node */
  byNode: Record<string, number>;
  /** Items by priority */
  byPriority: Record<QueuePriority, number>;
  /** Average wait time in queue (ms) */
  avgWaitTimeMs: number;
  /** Items processed in last interval */
  processedRecently: number;
  /** Items that timed out */
  timedOut: number;
  /** Queue utilization by node (percentage of max size) */
  utilization: Record<string, number>;
}

// ============================================================
// Failover System Types
// ============================================================

/** Recovery modes for failed sessions */
export type FailoverRecoveryMode = "restart" | "resume" | "abort";

/** Configuration for the failover system */
export interface FailoverConfig {
  /** Whether failover is enabled (default: true) */
  enabled?: boolean;
  /** Maximum number of failover attempts per session (default: 2) */
  maxAttempts?: number;
  /** Delay before attempting failover in ms (default: 5000) */
  failoverDelayMs?: number;
  /** Default recovery mode (default: "restart") */
  defaultRecoveryMode?: FailoverRecoveryMode;
  /** Timeout for failover operations in ms (default: 30000) */
  failoverTimeoutMs?: number;
  /** Whether to prefer nodes with similar capabilities (default: true) */
  preferSimilarCapabilities?: boolean;
}

/** Default failover configuration */
export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  enabled: true,
  maxAttempts: 2,
  failoverDelayMs: 5000,
  defaultRecoveryMode: "restart",
  failoverTimeoutMs: 30000,
  preferSimilarCapabilities: true,
};

/** Session state for failover tracking */
export interface SessionFailoverState {
  /** Original session key */
  originalSessionKey: string;
  /** Session run ID */
  runId: string;
  /** Node where session was running */
  originalNodeId: string;
  /** Task description */
  task: string;
  /** Agent ID */
  agentId?: string;
  /** Workspace context */
  workspace?: string;
  /** Model being used */
  model?: string;
  /** Session metadata */
  metadata?: Record<string, unknown>;
  /** Recovery mode for this session */
  recoveryMode: FailoverRecoveryMode;
  /** Number of failover attempts so far */
  attemptCount: number;
  /** Timestamp when session started */
  startedAt: number;
  /** Last checkpoint data (if any) */
  lastCheckpoint?: {
    timestamp: number;
    data: Record<string, unknown>;
  };
  /** Required capabilities */
  requiredCapabilities?: RequiredCapability[];
  /** Preferred capabilities */
  preferredCapabilities?: RequiredCapability[];
  /** Original spawn request */
  originalRequest: SessionSpawnRequest;
}

/** Failover attempt record */
export interface FailoverAttempt {
  /** Attempt ID */
  attemptId: string;
  /** Session being recovered */
  sessionKey: string;
  /** Source node that failed */
  failedNodeId: string;
  /** Target node for recovery */
  targetNodeId: string;
  /** Recovery mode used */
  recoveryMode: FailoverRecoveryMode;
  /** Attempt number */
  attemptNumber: number;
  /** Timestamp when attempt started */
  startedAt: number;
  /** Timestamp when attempt completed (success or failure) */
  completedAt?: number;
  /** Whether the attempt succeeded */
  success?: boolean;
  /** Error message if failed */
  error?: string;
  /** New session key if successful */
  newSessionKey?: string;
  /** Duration in milliseconds */
  durationMs?: number;
}

/** Result of a failover operation */
export interface FailoverResult {
  /** Whether failover succeeded */
  success: boolean;
  /** New session key if successful */
  newSessionKey?: string;
  /** Target node where session was recovered */
  targetNodeId?: string;
  /** Recovery mode used */
  recoveryMode: FailoverRecoveryMode;
  /** Error message if failed */
  error?: string;
  /** Duration of failover operation */
  durationMs: number;
  /** Attempt records */
  attempts: FailoverAttempt[];
}

/** Failover notification to originating session */
export interface FailoverNotification {
  /** Type of notification */
  type: "failover.started" | "failover.success" | "failover.failure";
  /** Original session key */
  originalSessionKey: string;
  /** New session key (if successful) */
  newSessionKey?: string;
  /** Failed node ID */
  failedNodeId: string;
  /** Recovery node ID (if successful) */
  recoveryNodeId?: string;
  /** Recovery mode used */
  recoveryMode: FailoverRecoveryMode;
  /** Error message (if failed) */
  error?: string;
  /** Duration of operation */
  durationMs?: number;
}

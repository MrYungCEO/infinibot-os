/**
 * Federation Module
 *
 * Exports all federation components for easy imports.
 */

// Types
export * from "./types.js";

// CRDTs
export {
  LWWRegister,
  GCounter,
  PNCounter,
  LWWSet,
  LWWMap,
  generateTimestamp,
  compareTimestamps,
} from "./crdt.js";

// Vector Clock
export {
  VectorClock,
  CausalHistory,
  createVectorClock,
  mergeVectorClocks,
  createVersionedValue,
  compareVersionedValues,
} from "./vector-clock.js";

export type { VersionedValue } from "./vector-clock.js";

// State Sync
export {
  StateSyncManager,
  getStateSyncManager,
  initStateSyncManager,
  startStateSyncManager,
  stopStateSyncManager,
} from "./state-sync.js";

export type { StateSyncEvents, StateSyncManagerOptions } from "./state-sync.js";

// Protocol
export {
  buildCapabilitiesMessage,
  buildComputeRouteMessage,
  buildErrorMessage,
  buildHeartbeatAckMessage,
  buildHeartbeatMessage,
  buildRegisterAckMessage,
  buildRegisterMessage,
  buildRoleChangeMessage,
  buildSessionSendMessage,
  buildSessionSpawnMessage,
  buildStateSyncAckMessage,
  buildStateSyncRequestMessage,
  buildStateUpdateMessage,
  deserializeMessage,
  FEDERATION_PROTOCOL_VERSION,
  generateMessageId,
  generateNodeId,
  getProtocolCompatibility,
  isMessageType,
  isProtocolVersionCompatible,
  isValidMessageType,
  isValidNodeId,
  PROTOCOL_MAGIC,
  serializeMessage,
  validateComputeRoutePayload,
  validateNodeRegisterPayload,
  validateRoleChangePayload,
  validateSessionSendPayload,
  validateSessionSpawnPayload,
  VALID_MESSAGE_TYPES,
} from "./protocol.js";

// Compute Manifest
export {
  buildLocalNodeManifest,
  calculateLoadScore,
  clearNodeManifests,
  detectAMDGPU,
  detectAppleSiliconGPU,
  detectGPU,
  detectNvidiaGPU,
  getAllNodeManifests,
  getCachedLocalManifest,
  getComputeStatus,
  getCPULoadPercent,
  getFreeRAMMB,
  getLocalManifest,
  getNodeManifest,
  getOllamaModels,
  getSystemRAMGB,
  getSystemRAMMB,
  isComfyUIAvailable,
  isOllamaAvailable,
  isVoiceAvailable,
  removeNodeManifest,
  startManifestRefresh,
  stopManifestRefresh,
  updateNodeManifest,
} from "./compute-manifest.js";

export type { ComputeStatus, GPUInfo } from "./compute-manifest.js";

// Compute Router
export {
  ComputeRouter,
  ComputeRoutingService,
  getComputeRouter,
  getComputeRoutingService,
  inferTaskType,
  initComputeRouter,
  initComputeRouting,
  routeImageGen,
  routeOllamaInference,
  routeSessionSpawn,
  routeVoiceProcessing,
  shutdownComputeRouting,
} from "./compute-router.js";

// Agent Tools
export {
  buildFederationTopologyContext,
  describeNode,
  getAllFederatedSessions,
  getConnectedNodes,
  getRemoteSessions,
  isNodeConnected,
  sendRemoteMessage,
  spawnRemoteSession,
  validateNodeParameter,
} from "./agent-tools.js";

export type {
  FederatedNodeInfo,
  RemoteMessageResult,
  RemoteSessionHandle,
  RemoteSessionInfo,
} from "./agent-tools.js";

// Hub (Master Node)
export {
  FederationHub,
  getFederationHub,
  initFederationHub,
  startFederationHub,
  stopFederationHub,
} from "./hub.js";

export type { ConnectedNode, FederationHubConfig, FederationHubEvents } from "./hub.js";

// Satellite (Client Node)
export {
  FederationSatellite,
  getFederationSatellite,
  connectSatellite,
  disconnectSatellite,
  createSatelliteFromConfig,
} from "./satellite.js";

export type { SatelliteConfig, SatelliteState, SatelliteEvents } from "./satellite.js";

// Tailscale Discovery
export {
  getTailscaleNetwork,
  discoverFederationMasters,
  buildTailscaleFederationUrl,
  resolveFederationMasterUrl,
  getSelfTailscaleHostname,
  probeFederationMaster,
  scanForFederationMasters,
} from "./tailscale-discovery.js";

export type {
  TailscalePeer,
  TailscaleNetwork,
  FederationMasterCandidate,
} from "./tailscale-discovery.js";

// MCP Proxy
export {
  invokeMCP,
  listFederationMCPs,
  findMCPNode,
  getMCPDescriptionForAgent,
  registerLocalMCP,
  unregisterLocalMCP,
  getLocalMCPServers,
  isMCPAvailable,
} from "./mcp-proxy.js";

// Load Balancer
export {
  FederationLoadBalancer,
  getLoadBalancer,
  initLoadBalancer,
  ensureLoadBalancer,
} from "./load-balancer.js";

export type { LoadBalancerEvents } from "./load-balancer.js";

// Resource Monitor
export {
  ResourceMonitor,
  getResourceMonitor,
  initResourceMonitor,
  startResourceMonitor,
  stopResourceMonitor,
  collectLocalMetrics,
  getCPUPercent,
  getMemoryPercent,
  getMemoryInfo,
  getGPUMetrics,
  getActiveSessions,
  getPendingTasks,
  registerSessionCountCallback,
  registerPendingTasksCallback,
} from "./resource-monitor.js";

export type { ResourceMonitorEvents } from "./resource-monitor.js";

// Event Bus
export {
  FederationEventBus,
  getEventBus,
  initEventBus,
  resetEventBus,
  publishSystemEvent,
  publishSessionEvent,
  publishTaskEvent,
  publishNodeEvent,
} from "./event-bus.js";

export type {
  FederationEventType,
  FederationEvent,
  FederationHubLike,
  UIBroadcastMessage,
} from "./event-bus.js";

// Identity Sync (Soul/Memory/Personality files + password)
export {
  IdentitySyncManager,
  IDENTITY_FILES,
  getIdentitySyncManager,
  initIdentitySyncManager,
  stopIdentitySyncManager,
} from "./identity-sync.js";

export type { IdentitySyncPayload, IdentitySyncAck, IdentitySyncConfig } from "./identity-sync.js";

// Mesh State (Agent Mesh Network)
export {
  MeshStateStore,
  getMeshState,
  initMeshState,
  resetMeshState,
  registerMeshAgent,
  updateMeshAgentStatus,
  sendMeshMessage,
  discoverMeshAgents,
} from "./mesh-state.js";

export type {
  MeshAgent,
  MeshAgentStatus,
  MeshMessage,
  MeshMessageType,
  MessagePriority,
  MessageHandler,
  AgentScore,
  OrchestrationChain,
} from "./mesh-state.js";

// Code Sync (Git-based federation code synchronization)
export {
  sync,
  syncDryRun,
  getStatus,
  statusTable,
  type SyncStatus,
  type SyncResult,
  type SyncDeviceMeta,
  type CodeSyncConfig,
} from "./code-sync.js";

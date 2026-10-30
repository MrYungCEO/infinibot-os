/**
 * Infinibot Federation Protocol
 *
 * WebSocket-based protocol for master-satellite communication.
 * Handles serialization, message validation, and version negotiation.
 */

import type {
  FederationMessage,
  FederationMessageType,
  NodeManifest,
  NodeCapabilities,
  SessionSpawnRequest,
  SessionSendRequest,
  SessionHandle,
  StateSyncPayload,
  StateUpdate,
  ComputeRequirements,
  ComputeRouteResult,
  ComputeStatus,
  MCPListRequest,
  MCPListResult,
  MCPInvokeRequest,
  MCPInvokeResult,
  RoleChangePayload,
} from "./types.js";
import { FederationError, FederationErrorCode } from "./types.js";
import type { SatelliteToken, OperationType } from "./security.js";

// =============================================================================
// Protocol Constants
// =============================================================================

/** Current protocol version */
export const FEDERATION_PROTOCOL_VERSION = 1;

/** Protocol magic bytes for validation */
export const PROTOCOL_MAGIC = "MOLTFED";

/** Maximum message size (128MB). Must accommodate a large knowledge-graph
 *  snapshot proxied via master.gateway.invoke.result; matches the WebSocket
 *  maxPayload on the satellite↔master socket. */
export const MAX_MESSAGE_SIZE = 128 * 1024 * 1024;

/** Heartbeat interval default (30s) */
export const DEFAULT_HEARTBEAT_INTERVAL = 30_000;

/** Heartbeat timeout default (10s) */
export const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;

// =============================================================================
// Message Payloads
// =============================================================================

/** Payload for node.register */
export interface NodeRegisterPayload {
  manifest: NodeManifest;
  protocolVersion: number;
}

/**
 * Security details attached to a register-ack when federation security is
 * enabled (master-side `federation.requireRegisterToken`). Absent otherwise so
 * the ack shape stays backwards-compatible for permissive deployments.
 */
export interface RegisterAckSecurityPayload {
  /** Server-issued, signed session token the satellite should present later. */
  sessionToken?: SatelliteToken;
  /** Fingerprint of the hub's public key for pinning / MITM detection. */
  publicKeyFingerprint?: string;
  /** Capability scopes (operations) the satellite has been granted. */
  scopes: OperationType[];
  /**
   * Durable per-device credential (no expiry), issued when a satellite joins
   * with a short-lived invite. The satellite stores it and presents it on
   * every later registration instead of the invite.
   */
  credential?: SatelliteToken;
}

/** Payload for node.register.ack */
export interface NodeRegisterAckPayload {
  success: boolean;
  nodeId: string;
  protocolVersion: number;
  error?: string;
  /** Present only when federation security is enabled (see TODO 2041). */
  security?: RegisterAckSecurityPayload;
}

/** Payload for node.heartbeat */
export interface NodeHeartbeatPayload {
  timestamp: number;
  load?: number;
  activeSessions?: number;
}

/** Payload for node.heartbeat.ack */
export interface NodeHeartbeatAckPayload {
  timestamp: number;
  serverTime: number;
}

/** Payload for node.capabilities */
export interface NodeCapabilitiesPayload {
  capabilities: NodeCapabilities;
}

/** Payload for node.disconnect */
export interface NodeDisconnectPayload {
  reason: string;
  reconnect: boolean;
}

/** Payload for role.change — exported from types.js, re-exported here for convenience */
export type { RoleChangePayload } from "./types.js";

/** Payload for session.spawn */
export interface SessionSpawnPayload extends SessionSpawnRequest {}

/** Payload for session.spawn.result */
export interface SessionSpawnResultPayload {
  success: boolean;
  handle?: SessionHandle;
  error?: string;
}

/** Payload for session.send */
export interface SessionSendPayload extends SessionSendRequest {}

/** Payload for session.send.result */
export interface SessionSendResultPayload {
  success: boolean;
  error?: string;
}

/** Payload for session.event */
export interface SessionEventPayload {
  sessionKey: string;
  event: string;
  data: unknown;
}

/** Payload for state.sync */
export interface StateSyncRequestPayload {
  requestFull: boolean;
  lastVersion?: number;
}

/** Payload for state.sync.ack */
export interface StateSyncAckPayload extends StateSyncPayload {}

/** Payload for state.update */
export interface StateUpdatePayload extends StateUpdate {}

/** Payload for compute.route */
export interface ComputeRoutePayload {
  requirements: ComputeRequirements;
  taskId?: string;
}

/** Payload for compute.route.result */
export interface ComputeRouteResultPayload extends ComputeRouteResult {}

/** Payload for compute.status */
export interface ComputeStatusPayload extends ComputeStatus {}

/** Payload for error */
export interface ErrorPayload {
  code: string;
  message: string;
  correlationId?: string;
  details?: unknown;
}

/** Payload for federation.batch */
export interface FederationBatchPayload {
  messages: string[];
  timestamp: number;
  messageId: string;
}

/** Payload for federation.compressed */
export interface FederationCompressedPayload {
  compressedPayload: string; // base64 encoded gzipped data
  originalSize: number;
  timestamp: number;
  messageId: string;
}

/** Payload for mcp.list */
export interface MCPListPayload extends MCPListRequest {}

/** Payload for mcp.list.result */
export interface MCPListResultPayload extends MCPListResult {}

/** Payload for mcp.invoke */
export interface MCPInvokePayload extends MCPInvokeRequest {}

/** Payload for mcp.invoke.result */
export interface MCPInvokeResultPayload extends MCPInvokeResult {}

/** Payload for delivery.ack */
export interface DeliveryAckPayload {
  /** ID of the message being acknowledged */
  messageId: string;
  /** Node that received the message */
  receiverId: string;
  /** Timestamp when the message was processed */
  timestamp: number;
}

// =============================================================================
// Payload Type Map
// =============================================================================

/**
 * Maps message types to their payload types.
 * Used for type-safe message handling.
 */
export interface FederationPayloadMap {
  "node.register": NodeRegisterPayload;
  "node.register.ack": NodeRegisterAckPayload;
  "node.heartbeat": NodeHeartbeatPayload;
  "node.heartbeat.ack": NodeHeartbeatAckPayload;
  "node.capabilities": NodeCapabilitiesPayload;
  "node.disconnect": NodeDisconnectPayload;
  "session.spawn": SessionSpawnPayload;
  "session.spawn.result": SessionSpawnResultPayload;
  "session.send": SessionSendPayload;
  "session.send.result": SessionSendResultPayload;
  "session.event": SessionEventPayload;
  "state.sync": StateSyncRequestPayload;
  "state.sync.ack": StateSyncAckPayload;
  "state.update": StateUpdatePayload;
  "compute.route": ComputeRoutePayload;
  "compute.route.result": ComputeRouteResultPayload;
  "compute.status": ComputeStatusPayload;
  "mcp.list": MCPListPayload;
  "mcp.list.result": MCPListResultPayload;
  "mcp.invoke": MCPInvokePayload;
  "mcp.invoke.result": MCPInvokeResultPayload;
  "federation.event": FederationEventPayload;
  "federation.batch": FederationBatchPayload;
  "federation.compressed": FederationCompressedPayload;
  "role.change": RoleChangePayload;
  "identity.sync": Record<string, unknown>;
  "identity.sync.ack": Record<string, unknown>;
  "identity.sync.request": Record<string, unknown>;
  "delivery.ack": DeliveryAckPayload;
  error: ErrorPayload;
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize a federation message to JSON string.
 * Adds timestamp if not present.
 */
export function serializeMessage<T extends keyof FederationPayloadMap>(
  type: T,
  payload: FederationPayloadMap[T],
  nodeId: string,
  options?: {
    messageId?: string;
    correlationId?: string;
    timestamp?: number;
  },
): string {
  const message: FederationMessage<FederationPayloadMap[T]> = {
    type,
    payload,
    nodeId,
    timestamp: options?.timestamp ?? Date.now(),
    messageId: options?.messageId,
    correlationId: options?.correlationId,
  };

  return JSON.stringify(message);
}

/**
 * Deserialize a JSON string to a federation message.
 * Validates structure but not payload content.
 */
export function deserializeMessage(data: string | Buffer): FederationMessage {
  const str = typeof data === "string" ? data : data.toString("utf-8");

  if (str.length > MAX_MESSAGE_SIZE) {
    throw new FederationError(
      FederationErrorCode.INVALID_MESSAGE,
      `Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch {
    throw new FederationError(
      FederationErrorCode.INVALID_MESSAGE,
      "Invalid JSON in federation message",
    );
  }

  if (!isValidMessageStructure(parsed)) {
    throw new FederationError(
      FederationErrorCode.INVALID_MESSAGE,
      "Invalid federation message structure",
    );
  }

  return parsed as FederationMessage;
}

/**
 * Validate message structure without full payload validation.
 */
function isValidMessageStructure(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;

  const msg = obj as Record<string, unknown>;

  return (
    typeof msg.type === "string" &&
    typeof msg.nodeId === "string" &&
    typeof msg.timestamp === "number" &&
    "payload" in msg
  );
}

// =============================================================================
// Message Validation
// =============================================================================

/**
 * All valid message types.
 */
export const VALID_MESSAGE_TYPES: FederationMessageType[] = [
  "node.register",
  "node.register.ack",
  "node.heartbeat",
  "node.heartbeat.ack",
  "node.capabilities",
  "node.disconnect",
  "session.spawn",
  "session.spawn.result",
  "session.send",
  "session.send.result",
  "session.event",
  "state.sync",
  "state.sync.ack",
  "state.update",
  "compute.route",
  "compute.route.result",
  "compute.status",
  "mcp.list",
  "mcp.list.result",
  "mcp.invoke",
  "mcp.invoke.result",
  "federation.event",
  "federation.batch",
  "federation.compressed",
  "identity.sync",
  "identity.sync.ack",
  "identity.sync.request",
  "memory.update",
  "memory.update.ack",
  "delivery.ack",
  // Generic gateway-RPC proxy + reverse event-broadcast — used by the
  // cross-device PTY pipe (terminal.create / terminal.write etc on the
  // satellite, terminal.output forwarded back to master).
  "gateway.proxy.invoke",
  "gateway.proxy.invoke.result",
  "gateway.proxy.invoke.stream",
  "gateway.proxy.invoke.stream.cancel",
  "master.gateway.invoke",
  "master.gateway.invoke.result",
  "event.broadcast",
  // master → satellite: forwards a gateway broadcast event to the
  // satellite that originated the underlying run via
  // master.gateway.invoke. Lets cross-device agent / terminal streaming
  // events reach the satellite's UI clients.
  "event.forward",
  "hardware.snapshot",
  "file-transfer.start",
  "file-transfer.chunk",
  "file-transfer.chunk.ack",
  "file-transfer.complete",
  "file-transfer.error",
  "file-transfer.pause",
  "file-transfer.resume",
  // Bidirectional memory sync (memory-sync.ts): satellite → master file
  // updates, master → satellite acks / broadcasts / conflict notices. Without
  // these the receiving node rejects them as "unknown message type" and the
  // memory-sync feature silently fails.
  "memory.update",
  "memory.update.ack",
  "memory.broadcast",
  "memory.conflict",
  "memory.request",
  "role.change",
  "error",
];

/**
 * Validate that a message type is recognized.
 */
export function isValidMessageType(type: string): type is FederationMessageType {
  return VALID_MESSAGE_TYPES.includes(type as FederationMessageType);
}

/**
 * Type guard for specific message types.
 */
export function isMessageType<T extends keyof FederationPayloadMap>(
  message: FederationMessage,
  type: T,
): message is FederationMessage<FederationPayloadMap[T]> {
  return message.type === type;
}

/**
 * Validate node.register payload.
 */
export function validateNodeRegisterPayload(payload: unknown): payload is NodeRegisterPayload {
  if (typeof payload !== "object" || payload === null) return false;

  const p = payload as Record<string, unknown>;

  if (typeof p.protocolVersion !== "number") return false;
  if (typeof p.manifest !== "object" || p.manifest === null) return false;

  const manifest = p.manifest as Record<string, unknown>;
  return (
    typeof manifest.id === "string" &&
    typeof manifest.name === "string" &&
    typeof manifest.hostname === "string" &&
    typeof manifest.workspace === "string" &&
    typeof manifest.capabilities === "object"
  );
}

/**
 * Validate session.spawn payload.
 */
export function validateSessionSpawnPayload(payload: unknown): payload is SessionSpawnPayload {
  if (typeof payload !== "object" || payload === null) return false;

  const p = payload as Record<string, unknown>;

  return (
    typeof p.nodeId === "string" && typeof p.agentId === "string" && typeof p.task === "string"
  );
}

/**
 * Validate session.send payload.
 */
export function validateSessionSendPayload(payload: unknown): payload is SessionSendPayload {
  if (typeof payload !== "object" || payload === null) return false;

  const p = payload as Record<string, unknown>;

  return (
    typeof p.nodeId === "string" &&
    typeof p.sessionKey === "string" &&
    typeof p.message === "string"
  );
}

/**
 * Validate compute.route payload.
 */
export function validateComputeRoutePayload(payload: unknown): payload is ComputeRoutePayload {
  if (typeof payload !== "object" || payload === null) return false;

  const p = payload as Record<string, unknown>;

  return typeof p.requirements === "object" && p.requirements !== null;
}

// =============================================================================
// Protocol Version Handling
// =============================================================================

/**
 * Check if a protocol version is compatible with current version.
 */
export function isProtocolVersionCompatible(remoteVersion: number): boolean {
  // For now, exact match required. Future: backward compatibility ranges.
  return remoteVersion === FEDERATION_PROTOCOL_VERSION;
}

/**
 * Get protocol compatibility info.
 */
export function getProtocolCompatibility(remoteVersion: number): {
  compatible: boolean;
  upgradeRequired: boolean;
  downgradeRequired: boolean;
  message: string;
} {
  if (remoteVersion === FEDERATION_PROTOCOL_VERSION) {
    return {
      compatible: true,
      upgradeRequired: false,
      downgradeRequired: false,
      message: "Protocol versions match",
    };
  }

  if (remoteVersion < FEDERATION_PROTOCOL_VERSION) {
    return {
      compatible: false,
      upgradeRequired: true,
      downgradeRequired: false,
      message: `Remote node uses protocol v${remoteVersion}, upgrade to v${FEDERATION_PROTOCOL_VERSION} required`,
    };
  }

  return {
    compatible: false,
    upgradeRequired: false,
    downgradeRequired: true,
    message: `Remote node uses protocol v${remoteVersion}, this node supports v${FEDERATION_PROTOCOL_VERSION}`,
  };
}

// =============================================================================
// Message Builders
// =============================================================================

/**
 * Build a node.register message.
 */
export function buildRegisterMessage(manifest: NodeManifest): string {
  return serializeMessage(
    "node.register",
    {
      manifest,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
    },
    manifest.id,
    { messageId: generateMessageId() },
  );
}

/**
 * Build a node.register.ack message.
 */
export function buildRegisterAckMessage(
  success: boolean,
  nodeId: string,
  error?: string,
  security?: RegisterAckSecurityPayload,
): string {
  return serializeMessage(
    "node.register.ack",
    {
      success,
      nodeId,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      error,
      ...(security ? { security } : {}),
    },
    "master",
  );
}

/**
 * Build a node.heartbeat message.
 */
export function buildHeartbeatMessage(
  nodeId: string,
  load?: number,
  activeSessions?: number,
): string {
  return serializeMessage(
    "node.heartbeat",
    {
      timestamp: Date.now(),
      load,
      activeSessions,
    },
    nodeId,
    { messageId: generateMessageId() },
  );
}

/**
 * Build a node.heartbeat.ack message.
 */
export function buildHeartbeatAckMessage(originalTimestamp: number): string {
  return serializeMessage(
    "node.heartbeat.ack",
    {
      timestamp: originalTimestamp,
      serverTime: Date.now(),
    },
    "master",
  );
}

/**
 * Build a node.capabilities message.
 */
export function buildCapabilitiesMessage(nodeId: string, capabilities: NodeCapabilities): string {
  return serializeMessage("node.capabilities", { capabilities }, nodeId);
}

/**
 * Build a session.spawn message.
 */
export function buildSessionSpawnMessage(fromNodeId: string, request: SessionSpawnRequest): string {
  return serializeMessage("session.spawn", request, fromNodeId, { messageId: generateMessageId() });
}

/**
 * Build a session.spawn.result message.
 */
export function buildSessionSpawnResultMessage(
  success: boolean,
  handle?: SessionHandle,
  error?: string,
  correlationId?: string,
): string {
  return serializeMessage("session.spawn.result", { success, handle, error }, "master", {
    correlationId,
  });
}

/**
 * Build a session.send message.
 */
export function buildSessionSendMessage(fromNodeId: string, request: SessionSendRequest): string {
  return serializeMessage("session.send", request, fromNodeId, { messageId: generateMessageId() });
}

/**
 * Build a state.sync request message.
 */
export function buildStateSyncRequestMessage(nodeId: string, lastVersion?: number): string {
  return serializeMessage(
    "state.sync",
    {
      requestFull: lastVersion === undefined,
      lastVersion,
    },
    nodeId,
    { messageId: generateMessageId() },
  );
}

/**
 * Build a state.sync.ack message with state payload.
 */
export function buildStateSyncAckMessage(
  syncPayload: StateSyncPayload,
  correlationId?: string,
): string {
  return serializeMessage("state.sync.ack", syncPayload, "master", { correlationId });
}

/**
 * Build a state.update message.
 */
export function buildStateUpdateMessage(update: StateUpdate): string {
  return serializeMessage("state.update", update, "master");
}

/**
 * Build a compute.route message.
 */
export function buildComputeRouteMessage(
  nodeId: string,
  requirements: ComputeRequirements,
  taskId?: string,
): string {
  return serializeMessage("compute.route", { requirements, taskId }, nodeId, {
    messageId: generateMessageId(),
  });
}

/**
 * Build an error message.
 */
export function buildErrorMessage(
  code: FederationErrorCode | string,
  message: string,
  correlationId?: string,
  details?: unknown,
): string {
  return serializeMessage("error", { code, message, correlationId, details }, "master", {
    correlationId,
  });
}

/**
 * Build a delivery.ack message.
 */
export function buildDeliveryAckMessage(messageId: string, receiverId: string): string {
  return serializeMessage(
    "delivery.ack",
    {
      messageId,
      receiverId,
      timestamp: Date.now(),
    },
    receiverId,
  );
}

// =============================================================================
// MCP Message Builders
// =============================================================================

/**
 * Build an mcp.list request message.
 */
export function buildMCPListMessage(nodeId: string, targetNodeId?: string): string {
  return serializeMessage("mcp.list", { nodeId: targetNodeId }, nodeId, {
    messageId: generateMessageId(),
  });
}

/**
 * Build an mcp.list.result message.
 */
export function buildMCPListResultMessage(result: MCPListResult, correlationId?: string): string {
  return serializeMessage("mcp.list.result", result, "master", { correlationId });
}

/**
 * Build an mcp.invoke request message.
 */
export function buildMCPInvokeMessage(nodeId: string, request: MCPInvokeRequest): string {
  return serializeMessage("mcp.invoke", request, nodeId, { messageId: generateMessageId() });
}

/**
 * Build an mcp.invoke.result message.
 */
export function buildMCPInvokeResultMessage(
  result: MCPInvokeResult,
  correlationId?: string,
): string {
  return serializeMessage("mcp.invoke.result", result, result.sourceNodeId, { correlationId });
}

/**
 * Validate mcp.invoke payload.
 */
export function validateMCPInvokePayload(payload: unknown): payload is MCPInvokePayload {
  if (typeof payload !== "object" || payload === null) return false;

  const p = payload as Record<string, unknown>;

  return (
    typeof p.mcpName === "string" &&
    typeof p.tool === "string" &&
    typeof p.args === "object" &&
    p.args !== null
  );
}

// =============================================================================
// Federation Event Message Builders
// =============================================================================

/** Federation event payload structure */
export interface FederationEventPayload {
  type: string;
  timestamp: number;
  sourceNodeId: string;
  payload: Record<string, unknown>;
}

/**
 * Build a federation.event message for broadcasting events across the network.
 */
export function buildFederationEventMessage(
  nodeId: string,
  eventPayload: FederationEventPayload,
): string {
  return serializeMessage("federation.event", eventPayload, nodeId, {
    messageId: generateMessageId(),
  });
}

/**
 * Build a role.change message — master tells a satellite to promote itself.
 */
export function buildRoleChangeMessage(nodeId: string, payload: RoleChangePayload): string {
  return serializeMessage("role.change", payload, nodeId, {
    messageId: generateMessageId(),
  });
}

/**
 * Validate role.change payload.
 */
export function validateRoleChangePayload(payload: unknown): payload is RoleChangePayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return p.newRole === "master";
}

/**
 * Validate federation.event payload.
 */
export function validateFederationEventPayload(
  payload: unknown,
): payload is FederationEventPayload {
  if (typeof payload !== "object" || payload === null) return false;

  const p = payload as Record<string, unknown>;

  return (
    typeof p.type === "string" &&
    typeof p.timestamp === "number" &&
    typeof p.sourceNodeId === "string" &&
    typeof p.payload === "object" &&
    p.payload !== null
  );
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
  return `fed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a unique node ID.
 */
export function generateNodeId(): string {
  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse a node ID to check validity.
 */
export function isValidNodeId(nodeId: string): boolean {
  return typeof nodeId === "string" && nodeId.length >= 4 && nodeId.length <= 64;
}

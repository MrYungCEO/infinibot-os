/**
 * Peer Mesh Manager
 *
 * Manages direct satellite-to-satellite WebSocket connections for P2P communication.
 * Allows satellites to communicate directly without going through the hub.
 *
 * Architecture:
 * 1. Satellites discover each other via hub
 * 2. Establish direct WebSocket connections
 * 3. Route messages directly when possible
 * 4. Fall back to hub relay if direct connection fails
 */

import { WebSocket, WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  FederationMessage,
  FederationMessageType,
  NodeManifest,
  SessionSpawnRequest,
  SessionSendRequest,
  SessionHandle,
} from "./types.js";
import {
  buildDeliveryAckMessage,
  deserializeMessage,
  generateMessageId,
  isValidMessageType,
} from "./protocol.js";
import { broadcastFederationEvent } from "./events.js";
import { getDeliveryManager, GUARANTEED_MESSAGE_TYPES } from "./delivery-manager.js";
import { sendWebSocketMessage } from "./ws-send.js";

const log = createSubsystemLogger("federation").child("peer-mesh");

// =============================================================================
// Types
// =============================================================================

/** Peer connection state */
export type PeerConnectionState = "disconnected" | "connecting" | "connected" | "failed";

/** Direct peer connection */
export interface PeerConnection {
  /** Remote peer node ID */
  nodeId: string;
  /** Remote peer manifest */
  manifest: NodeManifest;
  /** WebSocket connection */
  socket: WebSocket | null;
  /** Connection state */
  state: PeerConnectionState;
  /** Connection timestamp */
  connectedAt?: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Connection attempts */
  connectionAttempts: number;
  /** Last connection error */
  lastError?: string;
  /** Whether we initiated this connection (vs received) */
  isOutbound: boolean;
}

/** Peer message types (extends federation message types) */
export type PeerMessageType =
  | FederationMessageType
  | "peer.handshake"
  | "peer.handshake.ack"
  | "peer.ping"
  | "peer.pong"
  | "peer.session.spawn"
  | "peer.session.send"
  | "peer.session.result";

/** Peer handshake message */
export interface PeerHandshakePayload {
  nodeId: string;
  nodeName: string;
  protocolVersion: number;
  capabilities: string[];
}

/** Peer mesh configuration */
export interface PeerMeshConfig {
  /** Port for incoming peer connections (default: 47914) */
  peerPort?: number;
  /** Maximum peer connections (default: 20) */
  maxPeerConnections?: number;
  /** Connection timeout in ms (default: 10000) */
  connectionTimeoutMs?: number;
  /** Heartbeat interval for peer connections in ms (default: 30000) */
  peerHeartbeatMs?: number;
  /** Maximum connection attempts before giving up (default: 3) */
  maxConnectionAttempts?: number;
  /** Retry delay between connection attempts in ms (default: 5000) */
  retryDelayMs?: number;
  /** Local node manifest */
  localManifest: NodeManifest;
}

/** Peer mesh events */
export interface PeerMeshEvents {
  "peer:connected": (nodeId: string, manifest: NodeManifest) => void;
  "peer:disconnected": (nodeId: string, reason: string) => void;
  "peer:message": (nodeId: string, message: FederationMessage) => void;
  "peer:spawn:request": (nodeId: string, request: SessionSpawnRequest) => void;
  "peer:send:request": (nodeId: string, request: SessionSendRequest) => void;
  error: (error: Error) => void;
}

// =============================================================================
// Peer Mesh Manager
// =============================================================================

export class PeerMeshManager extends EventEmitter {
  private config: Required<PeerMeshConfig>;
  private server: WebSocketServer | null = null;
  private peers = new Map<string, PeerConnection>();
  private deliveryManager = getDeliveryManager();
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(config: PeerMeshConfig) {
    super();

    this.config = {
      peerPort: config.peerPort ?? 47914,
      maxPeerConnections: config.maxPeerConnections ?? 20,
      connectionTimeoutMs: config.connectionTimeoutMs ?? 10000,
      peerHeartbeatMs: config.peerHeartbeatMs ?? 30000,
      maxConnectionAttempts: config.maxConnectionAttempts ?? 3,
      retryDelayMs: config.retryDelayMs ?? 5000,
      localManifest: config.localManifest,
    };

    log.info(`peer mesh manager initialized`, {
      peerPort: this.config.peerPort,
      maxConnections: this.config.maxPeerConnections,
    });
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the peer mesh server to accept incoming connections.
   */
  async start(httpServer?: http.Server): Promise<void> {
    if (this.server) {
      throw new Error("Peer mesh server already started");
    }

    this.closed = false;

    // Create WebSocket server for peer connections
    this.server = new WebSocketServer({
      port: httpServer ? undefined : this.config.peerPort,
      server: httpServer,
      path: "/peer-mesh",
      maxPayload: 10 * 1024 * 1024,
    });

    this.server.on("connection", (socket, request) => {
      this.handleIncomingConnection(socket, request);
    });

    this.server.on("error", (error) => {
      log.error("peer mesh server error", { error });
      this.emit("error", error);
    });

    // Start heartbeat timer
    this.startHeartbeat();

    log.info(`peer mesh server started on port ${this.config.peerPort}`);
  }

  /**
   * Stop the peer mesh server and close all connections.
   */
  async stop(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();

    // Close all peer connections
    for (const [nodeId, peer] of this.peers) {
      await this.disconnectPeer(nodeId, "server shutdown");
    }

    // Close server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = null;
    }

    log.info("peer mesh server stopped");
  }

  // ===========================================================================
  // Peer Discovery & Connection
  // ===========================================================================

  /**
   * Update list of available peers from hub discovery.
   */
  updateAvailablePeers(nodes: NodeManifest[]): void {
    const currentPeerIds = new Set(this.peers.keys());
    const availablePeerIds = new Set(
      nodes.filter((node) => node.id !== this.config.localManifest.id).map((node) => node.id),
    );

    // Connect to new peers
    for (const node of nodes) {
      if (node.id === this.config.localManifest.id) continue;

      if (!this.peers.has(node.id) && this.peers.size < this.config.maxPeerConnections) {
        void this.connectToPeer(node);
      } else if (this.peers.has(node.id)) {
        // Update manifest
        const peer = this.peers.get(node.id)!;
        peer.manifest = node;
      }
    }

    // Disconnect from peers that are no longer available
    for (const nodeId of currentPeerIds) {
      if (!availablePeerIds.has(nodeId)) {
        log.info("pruning unavailable peer", {
          nodeId,
          reason: "node no longer in discovery list",
        });
        void this.disconnectPeer(nodeId, "node no longer available");
      }
    }
  }

  /**
   * Connect to a specific peer node.
   */
  private async connectToPeer(manifest: NodeManifest): Promise<void> {
    if (this.peers.has(manifest.id)) {
      log.debug(`already connected/connecting to peer: ${manifest.id}`);
      return;
    }

    const peer: PeerConnection = {
      nodeId: manifest.id,
      manifest,
      socket: null,
      state: "connecting",
      lastActivity: Date.now(),
      connectionAttempts: 0,
      isOutbound: true,
    };

    this.peers.set(manifest.id, peer);

    try {
      await this.attemptConnection(peer);
    } catch (error) {
      log.error(`connection refused: peer ${manifest.id} unreachable`, {
        nodeId: manifest.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      peer.state = "failed";
      peer.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Attempt WebSocket connection to peer.
   */
  private async attemptConnection(peer: PeerConnection): Promise<void> {
    const { manifest } = peer;
    peer.connectionAttempts++;

    log.info(
      `connecting to peer ${manifest.name} (${manifest.id}) at ${manifest.hostname}:${this.config.peerPort} (attempt ${peer.connectionAttempts}/${this.config.maxConnectionAttempts})`,
    );

    return new Promise((resolve, reject) => {
      const peerUrl = `ws://${manifest.hostname}:${this.config.peerPort}/peer-mesh`;
      const socket = new WebSocket(peerUrl, {
        maxPayload: 10 * 1024 * 1024,
      });

      const timeout = setTimeout(() => {
        log.warn("connection timeout: peer handshake did not complete in time", {
          nodeId: manifest.id,
          attempt: peer.connectionAttempts,
          timeoutMs: this.config.connectionTimeoutMs,
        });
        socket.close();
        reject(new Error("Connection timeout"));
      }, this.config.connectionTimeoutMs);

      socket.on("open", () => {
        clearTimeout(timeout);
        peer.socket = socket;
        peer.state = "connected";
        peer.connectedAt = Date.now();
        peer.lastActivity = Date.now();

        this.setupSocketHandlers(peer);
        this.sendHandshake(peer);

        log.info(`connected to peer: ${manifest.name} (${manifest.id})`);
        this.emit("peer:connected", manifest.id, manifest);
        broadcastFederationEvent("federation.peer.connected", {
          peerNodeId: manifest.id,
          ts: Date.now(),
        });
        resolve();
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        peer.state = "failed";
        peer.lastError = error.message;
        log.error("connection refused: peer socket error", {
          nodeId: manifest.id,
          reason: error.message,
        });
        reject(error);
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        if (peer.state === "connecting") {
          log.warn("connection closed during handshake", {
            nodeId: manifest.id,
            attempt: peer.connectionAttempts,
          });
          reject(new Error("Connection closed during handshake"));
        }
      });
    });
  }

  /**
   * Handle incoming peer connection.
   */
  private handleIncomingConnection(socket: WebSocket, request: http.IncomingMessage): void {
    log.info(`incoming peer connection from ${request.socket.remoteAddress}`);

    // Create temporary peer until we receive handshake
    const tempId = randomUUID();
    const peer: PeerConnection = {
      nodeId: tempId,
      manifest: {} as NodeManifest, // Will be filled from handshake
      socket,
      state: "connecting",
      lastActivity: Date.now(),
      connectionAttempts: 0,
      isOutbound: false,
    };

    this.setupSocketHandlers(peer);

    // Wait for handshake within timeout
    const handshakeTimeout = setTimeout(() => {
      log.warn("handshake timeout: incoming peer connection dropped", {
        nodeId: peer.nodeId,
        remoteAddr: request.socket.remoteAddress,
        reason: "no handshake received within timeout",
      });
      socket.close(1000, "handshake timeout");
    }, this.config.connectionTimeoutMs);

    // Handle handshake
    const handleHandshake = (message: FederationMessage) => {
      if (message.type === "peer.handshake") {
        clearTimeout(handshakeTimeout);
        this.handlePeerHandshake(peer, message.payload as PeerHandshakePayload);
      }
    };

    socket.on("message", (data) => {
      try {
        const message = deserializeMessage(data.toString());
        if (message.type === "peer.handshake") {
          handleHandshake(message);
        }
      } catch (error) {
        log.warn("message parse error: dropping incoming connection", {
          nodeId: peer.nodeId,
          reason: error instanceof Error ? error.message : String(error),
        });
        socket.close(1000, "invalid handshake");
      }
    });
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  /**
   * Setup WebSocket event handlers for a peer connection.
   */
  private setupSocketHandlers(peer: PeerConnection): void {
    if (!peer.socket) return;

    peer.socket.on("message", (data) => {
      this.handlePeerMessage(peer, Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
    });

    peer.socket.on("close", (code, reason) => {
      this.handlePeerDisconnect(peer, `close: ${code} ${reason}`);
    });

    peer.socket.on("error", (error) => {
      log.error(`peer socket error (${peer.nodeId})`, {
        error: error.message,
        nodeId: peer.nodeId,
      });
      peer.lastError = error.message;
    });
  }

  /**
   * Handle incoming message from peer.
   */
  private handlePeerMessage(peer: PeerConnection, data: Buffer): void {
    try {
      const message = deserializeMessage(data.toString());
      peer.lastActivity = Date.now();

      log.debug(`received message from peer ${peer.nodeId}:`, { type: message.type });

      if (
        message.messageId &&
        GUARANTEED_MESSAGE_TYPES.has(message.type as FederationMessageType)
      ) {
        if (this.deliveryManager.isDuplicate(message.messageId, peer.nodeId)) {
          // ACK duplicates so peer replay stops without double-applying the message.
          this.sendPeerRaw(
            peer,
            buildDeliveryAckMessage(message.messageId, this.config.localManifest.id),
          ).catch(() => undefined);
          return;
        }
        this.sendPeerRaw(
          peer,
          buildDeliveryAckMessage(message.messageId, this.config.localManifest.id),
        ).catch(() => undefined);
      }

      switch (message.type) {
        case "delivery.ack":
          this.deliveryManager.handleAck(
            (message.payload as { messageId?: string }).messageId ?? "",
          );
          break;
        case "peer.handshake":
          this.handlePeerHandshake(peer, message.payload as PeerHandshakePayload);
          break;
        case "peer.handshake.ack":
          this.handlePeerHandshakeAck(peer, message.payload);
          break;
        case "peer.ping":
          this.sendPeerMessage(peer, { type: "peer.pong", payload: message.payload });
          break;
        case "peer.pong":
          // Heartbeat response - peer is alive
          break;
        case "peer.session.spawn":
          this.emit("peer:spawn:request", peer.nodeId, message.payload as SessionSpawnRequest);
          break;
        case "peer.session.send":
          this.emit("peer:send:request", peer.nodeId, message.payload as SessionSendRequest);
          break;
        default:
          // Check if it's a known federation message type, otherwise warn
          if (!isValidMessageType(message.type)) {
            log.warn("unknown peer message type received", {
              nodeId: peer.nodeId,
              messageType: message.type,
              reason: "not a recognized federation or peer message type",
            });
          }
          // Forward other message types to listeners
          this.emit("peer:message", peer.nodeId, message);
          break;
      }
    } catch (error) {
      log.warn("message parse error from peer, skipping message", {
        nodeId: peer.nodeId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle peer handshake message.
   */
  private handlePeerHandshake(peer: PeerConnection, payload: PeerHandshakePayload): void {
    log.info(`received handshake from peer: ${payload.nodeName} (${payload.nodeId})`);

    // Update peer info
    peer.nodeId = payload.nodeId;
    peer.manifest = {
      id: payload.nodeId,
      name: payload.nodeName,
      hostname: "", // Will be filled from existing manifest
      port: 0,
      workspace: "",
      capabilities: {
        hasOllama: payload.capabilities.includes("ollama"),
        hasComfyUI: payload.capabilities.includes("comfyui"),
        hasVoice: payload.capabilities.includes("voice"),
        mcpServers: payload.capabilities.filter((c) => !["ollama", "comfyui", "voice"].includes(c)),
        agents: [],
        workspaces: [],
      },
      isMaster: false,
    };

    peer.state = "connected";

    // Move to correct map key
    if (this.peers.has(peer.nodeId) && this.peers.get(peer.nodeId) !== peer) {
      // Peer already exists, close this duplicate
      log.warn("duplicate peer handshake, closing connection", {
        nodeId: peer.nodeId,
        reason: "peer with same nodeId already connected",
      });
      peer.socket?.close(1000, "duplicate connection");
      return;
    }

    this.peers.set(peer.nodeId, peer);

    // Send handshake acknowledgment
    this.sendPeerMessage(peer, {
      type: "peer.handshake.ack",
      payload: {
        nodeId: this.config.localManifest.id,
        nodeName: this.config.localManifest.name,
        accepted: true,
      },
    });

    this.emit("peer:connected", peer.nodeId, peer.manifest);
    broadcastFederationEvent("federation.peer.connected", {
      peerNodeId: peer.nodeId,
      ts: Date.now(),
    });
  }

  /**
   * Handle peer handshake acknowledgment.
   */
  private handlePeerHandshakeAck(peer: PeerConnection, payload: any): void {
    if (payload.accepted) {
      log.info(`handshake accepted by peer: ${peer.manifest.name}`);
      peer.state = "connected";
    } else {
      log.warn("handshake rejected by peer", {
        nodeId: peer.nodeId,
        peerName: peer.manifest.name,
        reason: "peer sent accepted=false",
      });
      peer.socket?.close(1000, "handshake rejected");
    }
  }

  /**
   * Handle peer disconnection.
   */
  private handlePeerDisconnect(peer: PeerConnection, reason: string): void {
    log.info(`peer disconnected: ${peer.nodeId} (${reason})`);

    peer.socket = null;
    peer.state = "disconnected";

    this.emit("peer:disconnected", peer.nodeId, reason);
    broadcastFederationEvent("federation.peer.disconnected", {
      peerNodeId: peer.nodeId,
      ts: Date.now(),
    });

    // Retry connection if not closed and under retry limit
    if (
      !this.closed &&
      peer.isOutbound &&
      peer.connectionAttempts < this.config.maxConnectionAttempts
    ) {
      log.info("will retry peer connection", {
        nodeId: peer.nodeId,
        attempt: peer.connectionAttempts,
        maxAttempts: this.config.maxConnectionAttempts,
        retryDelayMs: this.config.retryDelayMs,
      });
      setTimeout(() => {
        if (!this.closed && this.peers.has(peer.nodeId)) {
          this.attemptConnection(peer).catch(() => {
            // Connection failed, will be handled by attemptConnection
          });
        }
      }, this.config.retryDelayMs);
    } else if (peer.isOutbound) {
      log.error("retry exhausted: giving up on peer connection", {
        nodeId: peer.nodeId,
        attempts: peer.connectionAttempts,
        maxAttempts: this.config.maxConnectionAttempts,
        reason,
      });
      // Remove peer if we can't reconnect
      this.peers.delete(peer.nodeId);
    } else {
      // Remove inbound peers immediately on disconnect
      this.peers.delete(peer.nodeId);
    }
  }

  // ===========================================================================
  // Message Sending
  // ===========================================================================

  /**
   * Send handshake to peer.
   */
  private sendHandshake(peer: PeerConnection): void {
    const payload: PeerHandshakePayload = {
      nodeId: this.config.localManifest.id,
      nodeName: this.config.localManifest.name,
      protocolVersion: 1,
      capabilities: [
        ...(this.config.localManifest.capabilities.hasOllama ? ["ollama"] : []),
        ...(this.config.localManifest.capabilities.hasComfyUI ? ["comfyui"] : []),
        ...(this.config.localManifest.capabilities.hasVoice ? ["voice"] : []),
        ...this.config.localManifest.capabilities.mcpServers,
      ],
    };

    this.sendPeerMessage(peer, { type: "peer.handshake", payload });
  }

  /**
   * Send message to a specific peer.
   */
  private sendPeerMessage(
    peer: PeerConnection,
    message: { type: PeerMessageType; payload: any },
  ): boolean {
    if (!peer.socket || peer.state !== "connected") {
      log.warn("cannot send message to disconnected peer", {
        nodeId: peer.nodeId,
        messageType: message.type,
        peerState: peer.state,
        reason: peer.socket ? `state=${peer.state}` : "socket is null",
      });
      return false;
    }

    const federationMessage: FederationMessage = {
      type: message.type,
      payload: message.payload,
      nodeId: this.config.localManifest.id,
      timestamp: Date.now(),
      messageId: generateMessageId(),
    };

    if (GUARANTEED_MESSAGE_TYPES.has(message.type as FederationMessageType)) {
      this.deliveryManager.sendMessage(federationMessage, peer.nodeId, (msg) =>
        this.sendPeerRaw(peer, JSON.stringify(msg)),
      );
      return true;
    }

    return this.sendPeerRawSync(peer, federationMessage);
  }

  private sendPeerRawSync(peer: PeerConnection, federationMessage: FederationMessage): boolean {
    const socket = peer.socket;
    if (!socket) return false;
    try {
      const raw = JSON.stringify(federationMessage);
      socket.send(raw, (error) => {
        if (!error) return;
        // Mid-send peer socket errors are surfaced asynchronously by ws.
        log.error("failed to send message to peer", {
          nodeId: peer.nodeId,
          messageType: federationMessage.type,
          reason: error.message,
        });
        broadcastFederationEvent("federation.message.failed", {
          fromNodeId: this.config.localManifest.id,
          toNodeId: peer.nodeId,
          msgId: federationMessage.messageId ?? "",
          reason: error.message,
          ts: Date.now(),
        });
      });
      peer.lastActivity = Date.now();
      broadcastFederationEvent("federation.message.sent", {
        fromNodeId: this.config.localManifest.id,
        toNodeId: peer.nodeId,
        messageType: federationMessage.type,
        msgId: federationMessage.messageId ?? "",
        ts: Date.now(),
      });
      return true;
    } catch (error) {
      log.error("failed to send message to peer", {
        nodeId: peer.nodeId,
        messageType: federationMessage.type,
        reason: error instanceof Error ? error.message : String(error),
      });
      broadcastFederationEvent("federation.message.failed", {
        fromNodeId: this.config.localManifest.id,
        toNodeId: peer.nodeId,
        msgId: federationMessage.messageId ?? "",
        reason: error instanceof Error ? error.message : String(error),
        ts: Date.now(),
      });
      return false;
    }
  }

  private async sendPeerRaw(peer: PeerConnection, raw: string): Promise<void> {
    if (!peer.socket || peer.state !== "connected") {
      throw new Error(`Peer ${peer.nodeId} is not connected`);
    }
    await sendWebSocketMessage(peer.socket, raw);
    peer.lastActivity = Date.now();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get all connected peers.
   */
  getConnectedPeers(): PeerConnection[] {
    return Array.from(this.peers.values()).filter((peer) => peer.state === "connected");
  }

  /**
   * Get specific peer by node ID.
   */
  getPeer(nodeId: string): PeerConnection | null {
    return this.peers.get(nodeId) || null;
  }

  /**
   * Check if we have a direct connection to a node.
   */
  isConnectedToPeer(nodeId: string): boolean {
    const peer = this.peers.get(nodeId);
    return peer?.state === "connected" && peer.socket !== null;
  }

  /**
   * Send a message directly to a peer (returns true if sent, false if needs hub relay).
   */
  sendMessageToPeer(nodeId: string, messageType: FederationMessageType, payload: any): boolean {
    const peer = this.peers.get(nodeId);
    if (!peer || peer.state !== "connected") {
      return false;
    }

    return this.sendPeerMessage(peer, { type: messageType, payload });
  }

  /**
   * Spawn session on peer (returns true if sent directly, false if needs hub relay).
   */
  spawnSessionOnPeer(nodeId: string, request: SessionSpawnRequest): Promise<SessionHandle> {
    return new Promise((resolve, reject) => {
      const peer = this.peers.get(nodeId);
      if (!peer || peer.state !== "connected") {
        reject(new Error("Peer not connected - use hub relay"));
        return;
      }

      const requestId = generateMessageId();
      request.nodeId = nodeId; // Ensure target is set

      // Set up response handler
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingRequests.delete(requestId);
          log.warn("peer spawn request timeout", {
            nodeId,
            requestId,
            reason: "no response within 30s",
          });
          reject(new Error("Peer spawn request timeout"));
        }, 30000),
      });

      // Send spawn request
      const success = this.sendPeerMessage(peer, {
        type: "peer.session.spawn",
        payload: { ...request, correlationId: requestId },
      });

      if (!success) {
        this.pendingRequests.delete(requestId);
        reject(new Error("Failed to send spawn request to peer"));
      }
    });
  }

  /**
   * Disconnect from specific peer.
   */
  async disconnectPeer(nodeId: string, reason: string): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (!peer) return;

    log.info(`disconnecting from peer ${nodeId}: ${reason}`);

    if (peer.socket) {
      try {
        peer.socket.close(1000, reason);
      } catch (error) {
        log.error("error closing peer socket", {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      peer.socket = null;
    }

    peer.state = "disconnected";
    this.peers.delete(nodeId);
    this.emit("peer:disconnected", nodeId, reason);
    broadcastFederationEvent("federation.peer.disconnected", {
      peerNodeId: nodeId,
      ts: Date.now(),
    });
  }

  // ===========================================================================
  // Heartbeat
  // ===========================================================================

  /**
   * Start heartbeat timer for peer connections.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, this.config.peerHeartbeatMs);
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
   * Send ping to all connected peers.
   */
  private sendHeartbeats(): void {
    const now = Date.now();
    for (const [nodeId, peer] of this.peers) {
      if (peer.state === "connected" && peer.socket) {
        // Check if peer is stale
        if (now - peer.lastActivity > this.config.peerHeartbeatMs * 2) {
          log.warn("heartbeat miss: peer stale, disconnecting", {
            nodeId,
            lastActivityMs: now - peer.lastActivity,
            thresholdMs: this.config.peerHeartbeatMs * 2,
            reason: "no activity within heartbeat window",
          });
          void this.disconnectPeer(nodeId, "heartbeat timeout");
          continue;
        }

        // Send ping
        this.sendPeerMessage(peer, {
          type: "peer.ping",
          payload: { timestamp: now },
        });
      }
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

let peerMeshManagerInstance: PeerMeshManager | null = null;

/**
 * Initialize peer mesh manager (singleton).
 */
export function initPeerMesh(config: PeerMeshConfig): PeerMeshManager {
  if (peerMeshManagerInstance) {
    throw new Error("Peer mesh manager already initialized");
  }

  peerMeshManagerInstance = new PeerMeshManager(config);
  return peerMeshManagerInstance;
}

/**
 * Get existing peer mesh manager instance.
 */
export function getPeerMesh(): PeerMeshManager | null {
  return peerMeshManagerInstance;
}

/**
 * Tailscale Discovery for Federation
 *
 * Provides Tailscale-aware node discovery and connection for the federation system:
 * - Detect if running on a Tailscale network
 * - List peers on the tailnet
 * - Auto-discover federation masters
 * - Build MagicDNS URLs for connections
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getTailnetHostname, readTailscaleStatusJson } from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";

const log = createSubsystemLogger("federation").child("tailscale");

// =============================================================================
// Types
// =============================================================================

export interface TailscalePeer {
  /** Tailscale node ID */
  id: string;
  /** Hostname (without domain) */
  hostname: string;
  /** Full MagicDNS name (e.g., "my-machine.tailnet-name.ts.net") */
  dnsName: string;
  /** Tailscale IPs (usually IPv4 and IPv6) */
  ips: string[];
  /** Whether the peer is currently online */
  online: boolean;
  /** Operating system */
  os?: string;
  /** Whether this is the current machine */
  isSelf: boolean;
  /** Tags assigned to this node */
  tags?: string[];
  /** Last seen timestamp */
  lastSeen?: number;
}

export interface TailscaleNetwork {
  /** Whether Tailscale is available and connected */
  connected: boolean;
  /** Current machine's MagicDNS name */
  selfDnsName?: string;
  /** Current machine's Tailscale IPs */
  selfIps: string[];
  /** Tailnet name (e.g., "tailnet-name.ts.net") */
  tailnetName?: string;
  /** All peers on the tailnet */
  peers: TailscalePeer[];
  /** Error message if not connected */
  error?: string;
}

export interface FederationMasterCandidate {
  /** Peer info */
  peer: TailscalePeer;
  /** Federation WebSocket URL */
  wsUrl: string;
  /** HTTPS URL for UI */
  httpsUrl: string;
  /** Whether this is likely a federation master (based on tags/hostname) */
  likelyMaster: boolean;
  /** Reason for being flagged as likely master */
  reason?: string;
}

// =============================================================================
// Tailscale Network Detection
// =============================================================================

/**
 * Check if Tailscale is available and get network status
 */
export async function getTailscaleNetwork(): Promise<TailscaleNetwork> {
  try {
    const status = await readTailscaleStatusJson(runExec, { timeoutMs: 5000 });

    if (!status || typeof status !== "object") {
      return { connected: false, selfIps: [], peers: [], error: "No status data" };
    }

    // Check if Tailscale is running
    const backendState = status.BackendState as string | undefined;
    if (backendState !== "Running") {
      return {
        connected: false,
        selfIps: [],
        peers: [],
        error: `Tailscale not running (state: ${backendState ?? "unknown"})`,
      };
    }

    // Get self info
    const self = status.Self as Record<string, unknown> | undefined;
    const selfDnsName = (self?.DNSName as string)?.replace(/\.$/, "");
    const selfIps = (self?.TailscaleIPs as string[]) ?? [];
    const selfId = self?.ID as string;

    // Extract tailnet name from DNS name
    const tailnetName = selfDnsName ? extractTailnetName(selfDnsName) : undefined;

    // Get peers
    const peerMap = status.Peer as Record<string, Record<string, unknown>> | undefined;
    const peers: TailscalePeer[] = [];

    if (peerMap) {
      for (const [_, peerData] of Object.entries(peerMap)) {
        const peer = parsePeer(peerData, false);
        if (peer) {
          peers.push(peer);
        }
      }
    }

    // Add self as a peer (for completeness)
    if (self) {
      const selfPeer = parsePeer(self, true);
      if (selfPeer) {
        peers.unshift(selfPeer);
      }
    }

    return {
      connected: true,
      selfDnsName,
      selfIps,
      tailnetName,
      peers,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Tailscale network check failed: ${message}`);
    return {
      connected: false,
      selfIps: [],
      peers: [],
      error: message,
    };
  }
}

/**
 * Parse a peer object from Tailscale status
 */
function parsePeer(data: Record<string, unknown>, isSelf: boolean): TailscalePeer | null {
  const id = data.ID as string | undefined;
  const hostname = data.HostName as string | undefined;
  const dnsName = (data.DNSName as string)?.replace(/\.$/, "");
  const ips = (data.TailscaleIPs as string[]) ?? [];
  const online = (data.Online as boolean) ?? false;
  const os = data.OS as string | undefined;
  const tags = data.Tags as string[] | undefined;
  const lastSeen = data.LastSeen as string | undefined;

  if (!id || !hostname) {
    return null;
  }

  return {
    id,
    hostname,
    dnsName: dnsName ?? hostname,
    ips,
    online: isSelf ? true : online,
    os,
    isSelf,
    tags,
    lastSeen: lastSeen ? new Date(lastSeen).getTime() : undefined,
  };
}

/**
 * Extract tailnet name from a MagicDNS name
 * e.g., "my-machine.tailnet-abc123.ts.net" -> "tailnet-abc123.ts.net"
 */
function extractTailnetName(dnsName: string): string | undefined {
  const parts = dnsName.split(".");
  if (parts.length >= 3) {
    return parts.slice(1).join(".");
  }
  return undefined;
}

// =============================================================================
// Federation Master Discovery
// =============================================================================

/** Default federation port */
const DEFAULT_FEDERATION_PORT = 47913;

/**
 * Find potential federation masters on the Tailscale network
 */
export async function discoverFederationMasters(
  port: number = DEFAULT_FEDERATION_PORT,
): Promise<FederationMasterCandidate[]> {
  const network = await getTailscaleNetwork();

  if (!network.connected) {
    log.debug("Tailscale not connected, cannot discover masters");
    return [];
  }

  const candidates: FederationMasterCandidate[] = [];

  for (const peer of network.peers) {
    // Skip offline peers and self
    if (!peer.online || peer.isSelf) {
      continue;
    }

    const candidate = buildMasterCandidate(peer, port);
    candidates.push(candidate);
  }

  // Sort by likelihood of being a master
  candidates.sort((a, b) => {
    if (a.likelyMaster && !b.likelyMaster) return -1;
    if (!a.likelyMaster && b.likelyMaster) return 1;
    return 0;
  });

  return candidates;
}

/**
 * Build a federation master candidate from a peer
 */
function buildMasterCandidate(peer: TailscalePeer, port: number): FederationMasterCandidate {
  // Build URLs using MagicDNS name (preferred) or IP
  const host = peer.dnsName || peer.ips[0];
  const wsUrl = `wss://${host}:${port}/federation`;
  const httpsUrl = `https://${host}:${port}`;

  // Check if this looks like a federation master
  const { likelyMaster, reason } = checkLikelyMaster(peer);

  return {
    peer,
    wsUrl,
    httpsUrl,
    likelyMaster,
    reason,
  };
}

/**
 * Check if a peer is likely to be a federation master based on heuristics
 */
function checkLikelyMaster(peer: TailscalePeer): { likelyMaster: boolean; reason?: string } {
  // Check tags for federation-related tags
  if (peer.tags?.some((tag) => tag.includes("infinibot") || tag.includes("federation"))) {
    return { likelyMaster: true, reason: "Tagged as infinibot/federation" };
  }

  // Check hostname patterns
  const hostname = peer.hostname.toLowerCase();
  const masterPatterns = [
    "master",
    "server",
    "hub",
    "gateway",
    "infinibot",
    "infinibot",
    "5090", // Common for powerful machines
  ];

  for (const pattern of masterPatterns) {
    if (hostname.includes(pattern)) {
      return { likelyMaster: true, reason: `Hostname contains "${pattern}"` };
    }
  }

  // Check OS - Linux servers are more likely to be masters
  if (peer.os === "linux") {
    return { likelyMaster: true, reason: "Linux server" };
  }

  return { likelyMaster: false };
}

// =============================================================================
// URL Building Helpers
// =============================================================================

/**
 * Build a federation WebSocket URL for a Tailscale peer
 */
export function buildTailscaleFederationUrl(
  peerHostname: string,
  port: number = DEFAULT_FEDERATION_PORT,
  useHttps: boolean = true,
): string {
  const protocol = useHttps ? "wss" : "ws";
  return `${protocol}://${peerHostname}:${port}/federation`;
}

/**
 * Resolve a federation master URL, handling various input formats:
 * - Full URL: ws://192.168.1.100:47913/federation
 * - IP:port: 192.168.1.100:47913
 * - Tailscale hostname: my-server (will add .ts.net domain)
 * - Tailscale MagicDNS: my-server.tailnet.ts.net
 */
export async function resolveFederationMasterUrl(
  input: string,
  defaultPort: number = DEFAULT_FEDERATION_PORT,
): Promise<string> {
  // Already a full URL
  if (input.startsWith("ws://") || input.startsWith("wss://")) {
    // Ensure /federation path
    const url = new URL(input);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/federation";
    }
    return url.toString();
  }

  // Check if it's a Tailscale hostname (no dots or ends with .ts.net)
  const network = await getTailscaleNetwork();

  if (network.connected) {
    // Try to find a matching peer
    const normalizedInput = input.toLowerCase().replace(/:\d+$/, "");

    for (const peer of network.peers) {
      if (
        peer.hostname.toLowerCase() === normalizedInput ||
        peer.dnsName.toLowerCase() === normalizedInput ||
        peer.dnsName.toLowerCase().startsWith(normalizedInput + ".")
      ) {
        // Extract port if provided
        const portMatch = input.match(/:(\d+)$/);
        const port = portMatch ? parseInt(portMatch[1], 10) : defaultPort;

        // Use MagicDNS name with HTTPS (Tailscale provides automatic certs)
        return `wss://${peer.dnsName}:${port}/federation`;
      }
    }

    // If input looks like a short hostname and we're on Tailscale, try MagicDNS
    if (!input.includes(".") && network.tailnetName) {
      const portMatch = input.match(/:(\d+)$/);
      const port = portMatch ? parseInt(portMatch[1], 10) : defaultPort;
      const hostname = input.replace(/:\d+$/, "");
      return `wss://${hostname}.${network.tailnetName}:${port}/federation`;
    }
  }

  // Fall back to treating as IP:port or hostname:port
  const hasPort = input.includes(":");
  const [host, portStr] = hasPort ? input.split(":") : [input, String(defaultPort)];
  const port = parseInt(portStr, 10);

  // Use ws:// for local IPs, wss:// for hostnames (assume Tailscale certs)
  const isLocalIp = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host);
  const protocol = isLocalIp ? "ws" : "wss";

  return `${protocol}://${host}:${port}/federation`;
}

/**
 * Get the current machine's Tailscale hostname for advertising
 */
export async function getSelfTailscaleHostname(): Promise<string | null> {
  try {
    const hostname = await getTailnetHostname();
    return hostname || null;
  } catch {
    return null;
  }
}

// =============================================================================
// Probe for Federation Masters
// =============================================================================

/**
 * Probe a potential master to check if it's running federation
 */
export async function probeFederationMaster(
  url: string,
  timeoutMs: number = 5000,
): Promise<{ available: boolean; version?: number; nodeId?: string; error?: string }> {
  const { WebSocket } = await import("ws");

  return new Promise((resolve) => {
    let resolved = false;

    const ws = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      // Skip cert verification for self-signed (Tailscale certs are valid)
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve({ available: false, error: "Connection timeout" });
      }
    }, timeoutMs);

    ws.on("open", () => {
      // Send a probe message
      ws.send(
        JSON.stringify({
          type: "probe",
          timestamp: Date.now(),
        }),
      );
    });

    ws.on("message", (data) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve({
          available: true,
          version: msg.protocolVersion,
          nodeId: msg.nodeId,
        });
      } catch {
        ws.close();
        resolve({ available: true });
      }
    });

    ws.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({ available: false, error: err.message });
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      // If we got here without resolving, the connection was rejected
    });
  });
}

/**
 * Scan Tailscale network for active federation masters
 */
export async function scanForFederationMasters(
  port: number = DEFAULT_FEDERATION_PORT,
  timeoutMs: number = 3000,
): Promise<FederationMasterCandidate[]> {
  const candidates = await discoverFederationMasters(port);

  if (candidates.length === 0) {
    return [];
  }

  log.info(`Scanning ${candidates.length} Tailscale peers for federation masters...`);

  // Probe all candidates in parallel
  const probeResults = await Promise.all(
    candidates.map(async (candidate) => {
      const result = await probeFederationMaster(candidate.wsUrl, timeoutMs);
      return { candidate, result };
    }),
  );

  // Filter to available masters
  const available = probeResults
    .filter(({ result }) => result.available)
    .map(({ candidate }) => ({
      ...candidate,
      likelyMaster: true, // Confirmed available
      reason: "Responding to federation probe",
    }));

  log.info(`Found ${available.length} active federation masters`);
  return available;
}

/**
 * Federation Control Center gateway handlers.
 *
 * Methods the Control Center view calls that had no handler at all
 * (`federation.mcp.test`, `federation.node.wake`, `compute.node.status`).
 * They live in their own module rather than `./federation.ts` so the
 * ~3k-line core federation surface stays as-is.
 */

import { createSocket } from "node:dgram";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getFederationHub } from "../../federation/index.js";
import { listFederationMCPs } from "../../federation/mcp-proxy.js";
import { getCapabilityRouter } from "../../federation/capability-router.js";
import { collectLocalMetrics } from "../../federation/resource-monitor.js";
import { loadConfig } from "../../config/io.js";
import type { GatewayRequestHandlers } from "./types.js";

const execAsync = promisify(exec);

// ── Wake-on-LAN ─────────────────────────────────────────

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

function normalizeMac(mac: string): string | null {
  const trimmed = mac.trim();
  return MAC_RE.test(trimmed) ? trimmed.replace(/-/g, ":").toLowerCase() : null;
}

/**
 * Look a MAC up in the OS ARP cache by IP/hostname. Works on Windows
 * (`arp -a`) and Linux/macOS (`arp -n <host>` / `arp -a`); returns null when
 * the host has no cached entry — which is the common case for a machine that
 * is already asleep and has aged out of the table.
 */
async function lookupMacFromArp(host: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(process.platform === "win32" ? "arp -a" : "arp -an", {
      timeout: 5000,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(host)) continue;
      const match = line.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
      if (match) return normalizeMac(match[0]);
    }
  } catch {
    // arp missing or failed — treated the same as "not found".
  }
  return null;
}

/** Send a Wake-on-LAN magic packet (6×0xFF + MAC repeated 16×). */
function sendMagicPacket(mac: string, broadcast: string, port: number): Promise<void> {
  const bytes = mac.split(":").map((b) => parseInt(b, 16));
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) {
    Buffer.from(bytes).copy(packet, 6 + i * 6);
  }

  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export const federationControlHandlers: GatewayRequestHandlers = {
  /**
   * Probe whether an MCP server is actually reachable on a node, as opposed
   * to merely being present in the registry. `federation.mcp.list` is the
   * live enumeration path (it queries the hub for satellites), so a server
   * showing up there is the reachability signal.
   */
  "federation.mcp.test": async ({ params, respond }) => {
    const mcpId = ((params.mcpId as string) || (params.mcpName as string) || "").trim();
    const nodeId = (params.nodeId as string) || undefined;

    if (!mcpId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "mcpId required" });
      return;
    }

    try {
      const { servers } = await listFederationMCPs(nodeId);
      const server = servers.find((s) => s.name === mcpId);

      if (!server) {
        respond(true, {
          success: false,
          mcpId,
          nodeId,
          message: nodeId
            ? `MCP "${mcpId}" is not registered on node ${nodeId}`
            : `MCP "${mcpId}" is not registered in this federation`,
        });
        return;
      }

      const toolCount = Array.isArray(server.tools) ? server.tools.length : undefined;
      const status = server.status;
      respond(true, {
        success: true,
        mcpId,
        nodeId: server.nodeId ?? nodeId,
        status,
        toolCount,
        message:
          toolCount === undefined
            ? `MCP "${mcpId}" is reachable`
            : `MCP "${mcpId}" is reachable (${toolCount} tools)`,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "MCP_TEST_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Wake a sleeping node with a Wake-on-LAN magic packet.
   *
   * The federation node manifest does not carry a MAC address, so callers
   * should pass `mac` explicitly; failing that we try the OS ARP cache for
   * the node's last-known hostname. When neither yields a MAC we answer
   * `{ success: false, error }` rather than raising — the Control Center
   * renders that as a failed wake instead of an exception.
   */
  "federation.node.wake": async ({ params, respond }) => {
    const nodeId = (params.nodeId as string) || "";
    const explicitMac = typeof params.mac === "string" ? normalizeMac(params.mac) : null;
    const broadcast = (params.broadcast as string) || "255.255.255.255";
    const port = typeof params.port === "number" ? params.port : 9;

    let mac = explicitMac;
    let resolvedFrom = explicitMac ? "params" : "";

    if (!mac && typeof params.mac === "string") {
      respond(true, { success: false, nodeId, error: `Invalid MAC address: ${params.mac}` });
      return;
    }

    if (!mac && nodeId) {
      const node = getFederationHub()?.getNode?.(nodeId);
      const host = node?.manifest?.hostname;
      if (host) {
        mac = await lookupMacFromArp(host);
        if (mac) resolvedFrom = `arp:${host}`;
      }
    }

    if (!mac) {
      respond(true, {
        success: false,
        nodeId,
        error:
          "No MAC address available for this node. Pass `mac` explicitly — the " +
          "node manifest does not carry one and it is not in the ARP cache.",
      });
      return;
    }

    try {
      await sendMagicPacket(mac, broadcast, port);
      respond(true, { success: true, nodeId, mac, resolvedFrom, broadcast, port });
    } catch (err) {
      respond(true, {
        success: false,
        nodeId,
        mac,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Per-node compute metrics. The Control Center calls this as the per-node
   * fallback when the fleet-wide health roll-up is unavailable, and reads
   * `metrics.{cpuPercent,memoryPercent,gpuPercent,loadScore}`.
   */
  "compute.node.status": async ({ params, respond }) => {
    const config = loadConfig();
    const localNodeId = config.federation?.nodeId ?? "local";
    const nodeId = (params.nodeId as string) || localNodeId;

    if (nodeId === localNodeId || nodeId === "local") {
      const metrics = await collectLocalMetrics(localNodeId);
      respond(true, { nodeId: localNodeId, isLocal: true, online: true, metrics });
      return;
    }

    const hub = getFederationHub();
    const node = hub?.getNode?.(nodeId);
    if (!node) {
      respond(true, { nodeId, isLocal: false, online: false, metrics: null });
      return;
    }

    // Satellites report metrics on every heartbeat; the capability router
    // holds the most recent sample.
    const metrics = getCapabilityRouter().getNodeMetrics(nodeId) ?? {
      nodeId,
      timestamp: node.lastHeartbeat,
      loadScore: node.currentLoad ?? 0,
      activeSessions: node.activeSessions ?? 0,
      cpuPercent: node.currentLoad ?? 0,
      memoryPercent: 0,
      pendingTasks: 0,
    };

    respond(true, {
      nodeId,
      isLocal: false,
      online: node.state === "registered",
      lastHeartbeat: node.lastHeartbeat,
      metrics,
    });
  },
};

export default federationControlHandlers;

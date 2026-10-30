/**
 * Federation Gateway Handlers
 *
 * Provides RPC methods for managing federation configuration and status.
 */

import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { loadConfig, writeConfigFile } from "../../config/io.js";
import type { FederationConfig } from "../../federation/types.js";
import os from "node:os";
import {
  getFederationHub,
  getFederationSatellite,
  connectSatellite,
  disconnectSatellite,
  stopFederationHub,
  scanForFederationMasters,
  probeFederationMaster,
  type ConnectedNode,
} from "../../federation/index.js";
import {
  invokeMCP,
  listFederationMCPs,
  findMCPNode,
  getMCPDescriptionForAgent,
} from "../../federation/mcp-proxy.js";
import { forwardGatewayCallToNode } from "../../federation/hub-forward.js";
import { encodeInvite } from "../../federation/invite.js";
import { getTunnelState } from "../server-cloudflare-tunnel.js";
import { getComputeRoutingService } from "../../federation/compute-router.js";
import { listTailnetAddresses } from "../../infra/tailnet.js";
import { getTailscaleNetwork } from "../../federation/tailscale-discovery.js";
import { getKanbanStore } from "../../tasks/store.js";
import { getDeadLetterQueue, type DeadLetterFilter } from "../../federation/dead-letter-queue.js";
import { getDirectoryStore } from "../../directories/store.js";
import { resolveStateDir } from "../../config/paths.js";
import type { NodeManifest } from "../../federation/types.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import { CODER_BACKEND_IDS } from "../../agents/coder-backend/types.js";

// ── Helpers ─────────────────────────────────────────────

/**
 * Resolve the externally-reachable federation WebSocket URL for a
 * satellite, for inclusion in `federation.nodes.list` payloads. The
 * mobile / web `nodeHttpBase` helper expects the shape
 * `ws://host:port/federation` — it strips `/federation` and converts
 * ws→http to produce the HTTP base used for voice / TTS / file fetch.
 *
 * Priority:
 *   1. `manifest.gatewayUrl` — the satellite explicitly advertised
 *      its reachable URL during registration. Trust it.
 *   2. Derived `ws://{manifest.hostname}:{manifest.port}/federation`
 *      — fallback for satellites that pre-date the `gatewayUrl` field.
 *      Fragile under NAT but lets mobile attempt a direct hit.
 *   3. `null` when no info is available, so callers can distinguish
 *      "satellite without URL" (real config gap, surface to user) from
 *      "field just missing" (old payload shape).
 */
export function satelliteReachableUrl(manifest: NodeManifest | undefined | null): string | null {
  if (!manifest) return null;
  if (manifest.gatewayUrl && manifest.gatewayUrl.trim()) {
    return manifest.gatewayUrl.trim();
  }
  if (manifest.hostname && manifest.port) {
    return `ws://${manifest.hostname}:${manifest.port}/federation`;
  }
  return null;
}

export type HubUrlCandidate = { type: string; url: string; label: string };

/**
 * Collect every candidate URL this gateway is reachable at, in preference
 * order: LAN interfaces, Tailscale IP, Tailscale MagicDNS name, Cloudflare
 * tunnel. Falls back to `localhost` only when nothing else resolved, so
 * callers that need a *real* reachable address (not a local fallback) can
 * check `urls[0]?.type !== "local"` before trusting the result.
 *
 * Shared by `federation.generateInvite` and `federation.urls` so the two
 * don't drift.
 */
export async function collectHubUrlCandidates(port: number): Promise<HubUrlCandidate[]> {
  const urls: HubUrlCandidate[] = [];

  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("100.")) {
        urls.push({
          type: "lan",
          url: `ws://${addr.address}:${port}/federation`,
          label: `LAN (${name})`,
        });
      }
    }
  }

  const tailnetAddrs = listTailnetAddresses();
  if (tailnetAddrs.ipv4.length > 0) {
    urls.push({
      type: "tailscale",
      url: `ws://${tailnetAddrs.ipv4[0]}:${port}/federation`,
      label: "Tailscale IP",
    });
  }

  try {
    const network = await getTailscaleNetwork();
    if (network?.selfDnsName) {
      urls.push({
        type: "tailscale",
        // ws:// not wss:// — the gateway port speaks plain WebSocket
        // (TLS only exists on 443 via `tailscale serve`). Tailnet
        // traffic is already encrypted by WireGuard.
        url: `ws://${network.selfDnsName}:${port}/federation`,
        label: "Tailscale DNS",
      });
    }
  } catch {
    /* not available */
  }

  const tunnelState = getTunnelState();
  if (tunnelState.url) {
    const wsUrl = tunnelState.url.replace(/^https?:\/\//, "wss://");
    urls.push({
      type: "tunnel",
      url: `${wsUrl}/federation`,
      label: "Cloudflare Tunnel (Public)",
    });
  }

  if (urls.length === 0) {
    urls.push({
      type: "local",
      url: `ws://localhost:${port}/federation`,
      label: "Localhost (fallback)",
    });
  }

  return urls;
}

// ── Schemas ─────────────────────────────────────────────

const FederationConfigSetSchema = z.object({
  mode: z.enum(["master", "satellite", "standalone"]).optional(),
  masterUrl: z.string().optional(),
  masters: z.array(z.string()).optional(),
  masterFailoverTimeoutMs: z.number().int().positive().optional(),
  nodeName: z.string().optional(),
  discovery: z.boolean().optional(),
});

const DeadLetterFilterSchema = z.object({
  failureReason: z.string().optional(),
  messageType: z.string().optional(),
  sourceNodeId: z.string().optional(),
  targetNodeId: z.string().optional(),
  retryable: z.boolean().optional(),
  newerThan: z.number().optional(),
  olderThan: z.number().optional(),
  limit: z.number().min(1).max(1000).optional(),
  offset: z.number().min(0).optional(),
});

const DeadLetterRetrySchema = z.object({
  id: z.string(),
});

const DeadLetterRemoveSchema = z.object({
  id: z.string(),
});

// In-memory federation selection store (per-process). Survives across requests
// for the lifetime of the gateway. Loss on restart is intentional — clients
// re-broadcast on reconnect.
const federationSelectionStore: Map<string, { nodeId: string; timestamp: number }> = new Map();

// ── Handlers ────────────────────────────────────────────

export const federationHandlers: GatewayRequestHandlers = {
  /**
   * Get federation configuration
   */
  "federation.config.get": async (opts: GatewayRequestHandlerOptions) => {
    const config = loadConfig();
    const federation: Partial<FederationConfig> = config.federation ?? {};

    opts.respond(true, {
      config: {
        mode: federation.mode ?? "standalone",
        masterUrl: federation.masterUrl ?? "",
        masters: federation.masters ?? [],
        masterFailoverTimeoutMs: federation.masterFailoverTimeoutMs ?? 30_000,
        nodeId: federation.nodeId ?? null,
        nodeName: federation.nodeName ?? null,
        discovery: federation.discovery ?? false,
      },
    });
  },

  /**
   * Update federation configuration
   */
  "federation.config.set": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = FederationConfigSetSchema.parse(opts.params);
    const config = loadConfig();

    // Initialize federation object if not present
    if (!config.federation) {
      (config as Record<string, unknown>).federation = { mode: "standalone" as const };
    }

    const fed = config.federation as FederationConfig;

    // Apply updates
    if (parsed.mode !== undefined) {
      fed.mode = parsed.mode;
    }
    if (parsed.masterUrl !== undefined) {
      fed.masterUrl = parsed.masterUrl;
    }
    if (parsed.masters !== undefined) {
      fed.masters = parsed.masters;
    }
    if (parsed.masterFailoverTimeoutMs !== undefined) {
      fed.masterFailoverTimeoutMs = parsed.masterFailoverTimeoutMs;
    }
    if (parsed.nodeName !== undefined) {
      fed.nodeName = parsed.nodeName;
    }
    if (parsed.discovery !== undefined) {
      fed.discovery = parsed.discovery;
    }

    // Save config
    await writeConfigFile(config);

    // If mode changed, apply runtime changes and schedule restart
    if (parsed.mode !== undefined) {
      const oldMode = config.federation?.mode ?? "standalone";
      const newMode = parsed.mode;

      if (oldMode !== newMode) {
        // Apply changes immediately where possible
        if (newMode === "master" || newMode === "standalone") {
          // Switching away from satellite — disconnect satellite
          try {
            await disconnectSatellite();
          } catch {
            /* best-effort */
          }
          fed.enabled = true;
          if (newMode === "master") {
            // Starting hub requires gateway restart to bind the WS path
            const { scheduleGatewaySigusr1Restart } = await import("../../infra/restart.js");
            scheduleGatewaySigusr1Restart({
              delayMs: 2000,
              reason: "federation.mode-change-to-master",
            });
          }
        } else if (newMode === "satellite") {
          // Switching away from master — stop hub
          try {
            await stopFederationHub();
          } catch {
            /* best-effort */
          }
          // Connecting as satellite requires masterUrl and a restart
          if (fed.masterUrl) {
            const { scheduleGatewaySigusr1Restart } = await import("../../infra/restart.js");
            scheduleGatewaySigusr1Restart({
              delayMs: 2000,
              reason: "federation.mode-change-to-satellite",
            });
          }
        }
      }
    }

    opts.respond(true, {
      success: true,
      config: {
        mode: fed.mode ?? "standalone",
        masterUrl: fed.masterUrl ?? "",
        nodeId: fed.nodeId ?? null,
        nodeName: fed.nodeName ?? null,
        discovery: fed.discovery ?? false,
      },
    });
  },

  /**
   * Get federation connection status
   */
  "federation.status": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    const satellite = getFederationSatellite();

    if (hub) {
      // We're a master node
      const connectedNodes = hub.getConnectedNodes?.() ?? [];
      opts.respond(true, {
        role: "master",
        connected: true,
        nodeCount: connectedNodes.length,
        nodes: connectedNodes.map((n: ConnectedNode) => ({
          id: n.id,
          name: n.manifest?.name ?? n.id,
          state: n.state,
        })),
      });
      return;
    }

    if (satellite) {
      // We're a satellite node - getState() returns the SatelliteState string
      const state = satellite.getState?.() ?? "disconnected";
      const detail = typeof satellite.getStatus === "function" ? satellite.getStatus() : undefined;
      opts.respond(true, {
        ...detail,
        role: "satellite",
        connected: state === "connected",
        state,
      });
      return;
    }

    // Standalone mode
    opts.respond(true, {
      role: "standalone",
      connected: false,
    });
  },

  /** Satellite: drop the master connection and reconnect now (OS resume, "Reconnect" button). */
  "federation.satellite.reconnect": async (opts: GatewayRequestHandlerOptions) => {
    const satellite = getFederationSatellite();
    if (!satellite) {
      opts.respond(false, undefined, {
        code: "NOT_SATELLITE",
        message: "This device is not a satellite.",
      });
      return;
    }
    satellite.reconnectNow?.(String((opts.params as { reason?: unknown })?.reason ?? "rpc"));
    opts.respond(true, { ok: true });
  },

  /**
   * Satellite: leave the federation. Asks the master to remove this device
   * (best effort), forgets the device credential and switches the config back
   * to a standalone install. The desktop app restarts the gateway afterwards.
   */
  "federation.satellite.leave": async (opts: GatewayRequestHandlerOptions) => {
    const satellite = getFederationSatellite();
    const { clearSatelliteCredential, readSatelliteCredential } =
      await import("../../federation/paired-devices.js");
    let masterNotified = false;
    if (satellite && satellite.getState?.() === "connected") {
      try {
        const cred = readSatelliteCredential();
        await satellite.invokeOnMaster("federation.devices.remove", {
          id: cred?.token.satelliteId ?? satellite.getManifest().id,
          nodeId: satellite.getManifest().id,
          reason: "left from the device",
        });
        masterNotified = true;
      } catch {
        /* master unreachable — still leave locally */
      }
    }
    try {
      await satellite?.disconnect();
    } catch {
      /* already closed */
    }
    clearSatelliteCredential();
    const { loadConfig, writeConfigFile } = await import("../../config/config.js");
    const cfg = loadConfig();
    const fed = { ...(cfg.federation ?? {}) } as Record<string, unknown>;
    delete fed.authToken;
    delete fed.masterUrl;
    delete fed.masters;
    delete fed.label;
    await writeConfigFile({
      ...cfg,
      federation: { ...fed, enabled: false, mode: "standalone" } as typeof cfg.federation,
    });
    opts.respond(true, { ok: true, masterNotified });
  },

  /** Master: devices that joined with an invite, with live online state. */
  "federation.devices.list": async (opts: GatewayRequestHandlerOptions) => {
    const { readPairedDevices } = await import("../../federation/paired-devices.js");
    const hub = getFederationHub();
    const online = new Map<string, ConnectedNode>();
    for (const n of hub?.getConnectedNodes?.() ?? []) online.set(n.id, n);
    const devices = readPairedDevices().map((d) => {
      const live = (d.nodeId && online.get(d.nodeId)) || online.get(d.satelliteId);
      return {
        ...d,
        online: Boolean(live) && !d.revokedAt,
        lastHeartbeat: live?.lastHeartbeat ?? null,
        capabilities: live?.manifest?.capabilities ?? null,
      };
    });
    opts.respond(true, { devices });
  },

  /** Master: remove (revoke) a paired device. It is disconnected and must re-join with a new invite. */
  "federation.devices.remove": async (opts: GatewayRequestHandlerOptions) => {
    const p = (opts.params ?? {}) as { id?: unknown; nodeId?: unknown };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
      return;
    }
    const { revokePairedDevice } = await import("../../federation/paired-devices.js");
    const { getFederationSecurity } = await import("../../federation/security.js");
    const rec = revokePairedDevice(id);
    const satelliteId = rec?.satelliteId ?? id;
    getFederationSecurity().revokeSatelliteToken(satelliteId);
    const hub = getFederationHub();
    const nodeId = (typeof p.nodeId === "string" && p.nodeId) || rec?.nodeId;
    if (hub && nodeId) {
      try {
        hub.disconnectNode?.(nodeId, "removed by the master");
      } catch {
        /* already gone */
      }
    }
    opts.respond(true, { ok: true, removed: Boolean(rec), satelliteId });
  },

  /**
   * Routing probe. Returns the id of the node that actually executed this
   * call. Used by `federation.selftest` to verify a request routed to the
   * intended node lands there — the same forward path both gateway sessions
   * and CLI coder spawns travel, with zero side effects.
   */
  "federation.ping": async (opts: GatewayRequestHandlerOptions) => {
    const { getLocalNodeId, isLocalNodeId } = await import("../../federation/local-node.js");
    const { forwardGatewayCall } = await import("../../federation/hub-forward.js");
    const p = (opts.params ?? {}) as { echo?: unknown; nodeId?: string; node?: string };
    const rawNodeId =
      (typeof p.nodeId === "string" ? p.nodeId.trim() : "") ||
      (typeof p.node === "string" ? p.node.trim() : "");
    // Route exactly like the spawn handlers so the probe travels the real
    // forward path. A non-local target is forwarded (nodeId stripped so the
    // call runs locally when it lands); a local target answers here.
    if (rawNodeId && !isLocalNodeId(rawNodeId)) {
      const { nodeId: _drop, node: _drop2, ...rest } = p;
      const fwd = await forwardGatewayCall<{ nodeId?: string; ts?: number; echo?: unknown }>(
        rawNodeId,
        "federation.ping",
        rest,
      );
      if (fwd.success) {
        opts.respond(true, fwd.payload);
        return;
      }
      if (fwd.code !== "NOT_FEDERATED") {
        opts.respond(false, undefined, {
          code: fwd.code ?? "FORWARD_FAILED",
          message: fwd.error ?? `Failed to route ping to ${rawNodeId}`,
        });
        return;
      }
    }
    opts.respond(true, {
      nodeId: getLocalNodeId() ?? "local",
      ts: Date.now(),
      echo: p.echo,
    });
  },

  /**
   * Federation self-test. Exercises the full cross-node routing matrix
   * (master↔satellite↔satellite, both directions) and reports pass/fail per
   * cell. MUST be run on the master (it drives every satellite origin via the
   * hub).
   *
   * For each (origin, target) pair it makes the ORIGIN node execute a probe
   * targeted at TARGET, then asserts the probe was answered by TARGET:
   *   - origin === master  → callGateway(method, { nodeId: target }) locally
   *   - origin === satellite → forwardGatewayCallToNode(origin, method,
   *       { nodeId: target }) so the satellite runs it and uses ITS OWN
   *       outbound router (proving sat→master and sat→sat).
   *
   * mode "ping" (default) routes `federation.ping` — fast, no side effects,
   * proves the transport both spawn types share. mode "spawn" performs a real
   * `sessions.spawn` per cell (and a CLI variant when includeCli) then tears
   * the children down — the full acceptance proof, opt-in because it launches
   * real sub-agents.
   */
  "federation.selftest": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      mode: z.enum(["ping", "spawn"]).optional(),
      includeCli: z.boolean().optional(),
      coderBackend: z.enum(CODER_BACKEND_IDS).optional(),
      targets: z.array(z.string()).optional(),
      teardown: z.boolean().optional(),
    });
    const args = schema.parse(opts.params ?? {});
    const mode = args.mode ?? "ping";
    const teardown = args.teardown !== false;

    const hub = getFederationHub();
    if (!hub) {
      opts.respond(false, undefined, {
        code: "NOT_MASTER",
        message:
          "federation.selftest must run on the master node (it drives every satellite origin).",
      });
      return;
    }
    const { getLocalNodeId } = await import("../../federation/local-node.js");
    const { callGateway } = await import("../call.js");
    const masterId = getLocalNodeId() ?? "master";

    const peers = hub
      .getConnectedNodes()
      .map((n) => n.id)
      .filter((id) => !args.targets || args.targets.includes(id));
    const allNodes = [masterId, ...peers];

    // Build the matrix: every ordered (origin, target) pair on distinct nodes.
    type Cell = { origin: string; target: string; direction: string };
    const cells: Cell[] = [];
    const dir = (o: string, t: string) =>
      o === masterId
        ? "master → satellite"
        : t === masterId
          ? "satellite → master"
          : "satellite → satellite";
    for (const origin of allNodes) {
      for (const target of allNodes) {
        if (origin === target) continue;
        cells.push({ origin, target, direction: dir(origin, target) });
      }
    }

    // Drive one method on `origin` targeting `target`.
    const driveOnOrigin = async (
      origin: string,
      method: string,
      params: Record<string, unknown>,
    ): Promise<{ success: boolean; payload?: unknown; error?: string; code?: string }> => {
      if (origin === masterId) {
        try {
          const payload = await callGateway({ method, params, timeoutMs: 30_000 });
          return { success: true, payload };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      // origin is a satellite: ask it (via the hub) to run the method itself,
      // so it uses its own outbound router to reach `target`.
      const fwd = await forwardGatewayCallToNode(origin, method, params, 30_000);
      return {
        success: fwd.success,
        payload: fwd.payload,
        error: fwd.error,
        code: fwd.code,
      };
    };

    const results: Array<Record<string, unknown>> = [];

    for (const cell of cells) {
      const variants: Array<{ kind: string; method: string; params: Record<string, unknown> }> = [];
      if (mode === "ping") {
        variants.push({
          kind: "transport",
          method: "federation.ping",
          params: { nodeId: cell.target, echo: `${cell.origin}->${cell.target}` },
        });
      } else {
        const stamp = `${cell.origin}->${cell.target}-${Date.now()}`;
        variants.push({
          kind: "gateway-session",
          method: "sessions.spawn",
          params: {
            nodeId: cell.target,
            task: `federation selftest probe ${stamp}`,
            label: "selftest",
            idempotencyKey: `selftest-gw-${stamp}`,
          },
        });
        if (args.includeCli) {
          variants.push({
            kind: "cli-coder",
            method: "sessions.spawn",
            params: {
              nodeId: cell.target,
              task: `federation selftest cli probe ${stamp}`,
              label: "selftest-cli",
              coderBackend: args.coderBackend ?? "claude-code",
              idempotencyKey: `selftest-cli-${stamp}`,
            },
          });
        }
      }

      for (const v of variants) {
        const res = await driveOnOrigin(cell.origin, v.method, v.params);
        let pass = false;
        let detail = "";
        if (!res.success) {
          detail = `${res.code ?? "ERROR"}: ${res.error ?? "forward failed"}`;
        } else if (mode === "ping") {
          const landedOn = (res.payload as { nodeId?: string } | undefined)?.nodeId;
          pass = landedOn === cell.target;
          detail = pass
            ? `answered by ${landedOn}`
            : `expected ${cell.target}, answered by ${landedOn ?? "?"}`;
        } else {
          const payload = res.payload as { runId?: string; childSessionKey?: string } | undefined;
          pass = !!(payload?.runId && payload?.childSessionKey);
          detail = pass ? `spawned runId=${payload?.runId}` : `no runId/sessionKey in reply`;
          if (pass && teardown && payload?.childSessionKey) {
            try {
              // Best-effort: abort the child on the node it runs on (target).
              await driveOnOrigin(cell.target, "agent.abort", {
                sessionKey: payload.childSessionKey,
              });
            } catch {
              // best-effort teardown
            }
          }
        }
        results.push({
          direction: cell.direction,
          origin: cell.origin,
          target: cell.target,
          variant: v.kind,
          pass,
          detail,
        });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    opts.respond(true, {
      mode,
      masterId,
      peers,
      nodeCount: allNodes.length,
      cellCount: cells.length,
      totalChecks: results.length,
      passed,
      failed: results.length - passed,
      allPassed: results.length > 0 && passed === results.length,
      results,
      note:
        peers.length === 0
          ? "No satellites connected — only local checks were possible. Connect at least one satellite (ideally two) for the full 6-cell matrix."
          : undefined,
    });
  },

  /**
   * Force a re-push of identity + shared config to every connected satellite.
   * Called by the wizard finalize / Notion-connect flows so freshly-saved
   * config (notion creds, provider keys, etc.) lands on satellites without
   * waiting for them to reconnect.
   */
  "federation.identity.push": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    if (!hub) {
      opts.respond(true, {
        success: false,
        error: "Not running as a master node — nothing to push.",
        pushed: 0,
      });
      return;
    }
    try {
      const result = await hub.pushIdentityToAll();
      opts.respond(true, {
        success: true,
        pushed: result.success,
        failed: result.failed,
      });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Get local node capabilities (for displaying in UI)
   */
  "federation.capabilities.local": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const { getLocalManifest } = await import("../../federation/compute-manifest.js");
      const capabilities = await getLocalManifest();
      opts.respond(true, { capabilities });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Connect to a master node (for satellites).
   * Accepts an optional invite bundle (base64 JSON from federation.generateInvite)
   * or a plain masterUrl. When invite is supplied the masterUrl and authToken are
   * decoded automatically.
   */
  "federation.connect": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      masterUrl: z.string().optional(),
      invite: z.string().optional(),
    });
    const parsed = schema.parse(opts.params);

    let masterUrl = parsed.masterUrl ?? "";
    let authToken: import("../../federation/security.js").SatelliteToken | undefined;
    let satelliteName: string | undefined;

    if (parsed.invite) {
      try {
        const bundle = JSON.parse(Buffer.from(parsed.invite, "base64").toString("utf8")) as {
          v: number;
          hubUrl: string;
          satelliteName?: string;
          token?: import("../../federation/security.js").SatelliteToken;
        };
        if (bundle.v !== 1 || !bundle.hubUrl) throw new Error("Malformed invite bundle");
        masterUrl = bundle.hubUrl;
        authToken = bundle.token;
        if (typeof bundle.satelliteName === "string" && bundle.satelliteName.trim()) {
          satelliteName = bundle.satelliteName.trim().slice(0, 48);
        }
      } catch (err) {
        opts.respond(true, {
          success: false,
          error: `Invalid invite: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    if (!masterUrl) {
      opts.respond(true, { success: false, error: "masterUrl or invite required" });
      return;
    }

    try {
      // When the invite named this satellite, adopt that name as our own
      // federation identity BEFORE connecting so the very first register the
      // master sees already carries the operator-chosen name (rather than this
      // device's hostname / the master's inherited name).
      if (satelliteName) {
        try {
          const cfg = loadConfig();
          const fed = { ...(cfg.federation ?? { mode: "satellite" as const }) } as FederationConfig;
          fed.nodeName = satelliteName;
          await writeConfigFile({ ...cfg, federation: fed });
        } catch (cfgErr) {
          console.warn(
            "[federation.connect] failed to persist satellite name:",
            cfgErr instanceof Error ? cfgErr.message : String(cfgErr),
          );
        }
      }
      await connectSatellite({ masterUrl, authToken, nodeName: satelliteName });
      opts.respond(true, { success: true, masterUrl, satelliteName });
    } catch (err) {
      opts.respond(true, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Disconnect from master node (for satellites)
   */
  "federation.disconnect": async (opts: GatewayRequestHandlerOptions) => {
    try {
      await disconnectSatellite();
      opts.respond(true, { success: true });
    } catch (err) {
      opts.respond(true, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Scan the LAN for federation masters via mDNS (satellite setup wizard)
   * Returns discovered masters as MasterUrlInfo-compatible objects.
   * timeoutMs: how long to listen (default 10s, max 20s).
   */
  "federation.discover-master": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      timeoutMs: z.number().min(2000).max(20000).optional(),
    });
    const { timeoutMs = 10000 } = schema.parse(opts.params ?? {});

    try {
      const { discoverMaster, isDiscoveryAvailable } =
        await import("../../federation/discovery.js");

      const available = await isDiscoveryAvailable();
      if (!available) {
        opts.respond(true, {
          success: false,
          error: "mDNS not available on this system",
          discovered: [],
        });
        return;
      }

      const master = await discoverMaster(timeoutMs);

      if (!master) {
        opts.respond(true, { success: true, discovered: [] });
        return;
      }

      opts.respond(true, {
        success: true,
        discovered: [
          {
            type: "lan" as const,
            url: master.wsUrl,
            label: `${master.nodeName} — mDNS`,
            nodeId: master.nodeId,
            host: master.host,
            port: master.port,
          },
        ],
      });
    } catch (err) {
      opts.respond(true, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        discovered: [],
      });
    }
  },

  /**
   * Scan network for federation masters (Tailscale/mDNS discovery)
   */
  "federation.scan": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const candidates = await scanForFederationMasters();
      opts.respond(true, {
        success: true,
        candidates: candidates.map((c) => ({
          wsUrl: c.wsUrl,
          httpsUrl: c.httpsUrl,
          hostname: c.peer.hostname,
          dnsName: c.peer.dnsName,
          ip: c.peer.ips?.[0] ?? null,
          likelyMaster: c.likelyMaster,
          reason: c.reason,
        })),
      });
    } catch (err) {
      opts.respond(true, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        candidates: [],
      });
    }
  },

  /**
   * Add a node to the federation
   * - On master: Probe and list a potential satellite (satellites connect to us, so this just probes)
   * - On satellite: Connect to a master URL
   */
  "federation.node.add": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      url: z.string(),
      name: z.string().optional(),
    });
    const { url, name } = schema.parse(opts.params);

    const hub = getFederationHub();
    const satellite = getFederationSatellite();
    const config = loadConfig();
    const mode = config.federation?.mode ?? "standalone";

    // If we're a satellite or standalone, treat this as "connect to master"
    if (!hub || mode === "satellite" || mode === "standalone") {
      try {
        // Build proper WebSocket URL
        let wsUrl = url;
        if (url.startsWith("http://")) {
          wsUrl = url.replace("http://", "ws://");
        } else if (url.startsWith("https://")) {
          wsUrl = url.replace("https://", "wss://");
        }
        if (!wsUrl.includes("/federation")) {
          wsUrl = wsUrl.replace(/\/?$/, "/federation");
        }

        // Connect as satellite
        await connectSatellite({ masterUrl: wsUrl, nodeName: name });

        // Update config to remember this
        if (!config.federation) {
          (config as Record<string, unknown>).federation = { mode: "satellite" as const };
        }
        config.federation!.mode = "satellite";
        config.federation!.masterUrl = wsUrl;
        if (name) config.federation!.nodeName = name;
        await writeConfigFile(config);

        const sat = getFederationSatellite();
        opts.respond(true, {
          success: true,
          connected: sat?.getState?.() === "connected",
          node: {
            id: "master",
            name: name ?? "Master",
            url: wsUrl,
            status: sat?.getState?.() ?? "connecting",
          },
        });
      } catch (err) {
        opts.respond(true, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // We're a master - probe the URL to see if it's a valid federation endpoint
    // Note: In federation, satellites connect TO masters, not vice versa
    // So this is mainly for discovery/probing purposes
    try {
      let wsUrl = url;
      if (url.startsWith("http://")) {
        wsUrl = url.replace("http://", "ws://");
      } else if (url.startsWith("https://")) {
        wsUrl = url.replace("https://", "wss://");
      }
      if (!wsUrl.includes("/federation")) {
        wsUrl = wsUrl.replace(/\/?$/, "/federation");
      }

      const probeResult = await probeFederationMaster(wsUrl, 5000);

      if (probeResult.available) {
        opts.respond(true, {
          success: true,
          message:
            "Node is reachable. In federation, satellites connect to masters - share your master URL with the satellite.",
          node: {
            id: probeResult.nodeId ?? "unknown",
            name: name ?? url,
            url: wsUrl,
            status: "reachable",
            version: probeResult.version,
          },
        });
      } else {
        opts.respond(true, {
          success: false,
          error: probeResult.error ?? "Node not reachable",
        });
      }
    } catch (err) {
      opts.respond(true, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Remove a node from the federation
   * - On master: Disconnect a connected satellite
   * - On satellite: Disconnect from master
   */
  "federation.node.remove": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      nodeId: z.string(),
    });
    const { nodeId } = schema.parse(opts.params);

    const hub = getFederationHub();

    if (hub) {
      // We're a master - disconnect the specified satellite
      try {
        hub.disconnectNode(nodeId, "removed via UI");
        opts.respond(true, { success: true, nodeId });
      } catch (err) {
        opts.respond(true, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // We're a satellite - if nodeId is "master" or matches, disconnect
    const satellite = getFederationSatellite();
    if (satellite) {
      try {
        await disconnectSatellite();
        opts.respond(true, { success: true, nodeId });
      } catch (err) {
        opts.respond(true, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    opts.respond(true, {
      success: false,
      error: "No federation connection to remove",
    });
  },

  /**
   * Get list of connected nodes (for masters) or master info (for satellites)
   * Always includes local node for master/standalone modes
   */
  "federation.nodes.list": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    const satellite = getFederationSatellite();
    const config = loadConfig();

    // Helper to get local node info
    const getLocalNode = async () => {
      const { getLocalVersionInfo } = await import("../../infra/version-info.js");
      const localInfo = await getLocalVersionInfo();
      // Surface the local node's externally-reachable URL the same way
      // we do for connected satellites. Without this, mobile clients
      // built from a federation-aware branch get `url: undefined` for
      // the local node and either fail outright or fall back to
      // hard-coded localhost — broken when the phone is hitting master
      // from the LAN. `federation.publicUrl` is the operator-set field
      // we already added for satellites; on master it serves the same
      // role (advertise the LAN/WAN URL clients can reach this node at).
      const cfgPublicUrl = config.federation?.publicUrl;
      const localUrl =
        typeof cfgPublicUrl === "string" && cfgPublicUrl.trim() ? cfgPublicUrl.trim() : null;
      return {
        id: config.federation?.nodeId ?? "local",
        name: config.federation?.nodeName ?? localInfo.hostname ?? os.hostname(),
        status: "online" as const,
        role: hub ? "master" : "standalone",
        platform: process.platform,
        isLocal: true,
        lastSeen: Date.now(),
        capabilities: {
          version: localInfo.version ?? "unknown",
        },
        url: localUrl,
        gatewayUrl: localUrl,
      };
    };

    if (hub) {
      const satellites = hub.getConnectedNodes?.() ?? [];
      const localNode = await getLocalNode();
      // Paired-nodes store holds operator-set display names from
      // `node.rename`. Overlay them so a rename via the federation UI
      // is reflected here instead of the satellite's (stale) manifest
      // name. Without this, the rename is persisted to disk but never
      // surfaces, so the UI re-fetch shows the old name.
      const pairedByNodeId = new Map<string, string>();
      try {
        const { paired } = await listNodePairing();
        for (const p of paired) {
          if (p?.nodeId && p.displayName) pairedByNodeId.set(p.nodeId, p.displayName);
        }
      } catch {
        /* best-effort — empty map falls back to manifest name */
      }
      opts.respond(true, {
        success: true,
        role: "master",
        nodes: [
          // Local master node first
          localNode,
          // Then all connected satellites
          ...satellites.map((n: ConnectedNode) => ({
            id: n.id,
            name: pairedByNodeId.get(n.id) ?? n.manifest?.name ?? n.id,
            status: n.state === "registered" ? "online" : n.state,
            role: "satellite",
            isLocal: false,
            // Externally-reachable URL the mobile/web clients can use to
            // hit this satellite's gateway directly (voice, TTS, file
            // fetch) instead of falling back to the master. Prefer
            // whatever the satellite advertised in its manifest; fall
            // back to deriving from hostname+port for older satellites
            // that pre-date the gatewayUrl field. Always null when no
            // info is available so callers can distinguish "satellite
            // without URL" from "field just missing".
            url: satelliteReachableUrl(n.manifest),
            gatewayUrl: n.manifest?.gatewayUrl ?? null,
            connectedAt: n.connectedAt,
            lastHeartbeat: n.lastHeartbeat,
            lastSeen: n.lastHeartbeat ?? n.connectedAt,
            load: n.currentLoad,
            activeSessions: n.activeSessions,
            capabilities: n.manifest?.capabilities,
          })),
        ],
      });
      return;
    }

    if (satellite) {
      // Satellites enumerate the federation roster from two sources:
      //   1. The master itself (always shown, even when disconnected so
      //      the UI can render an "offline" indicator)
      //   2. Every peer satellite that master sync'd via state.sync.ack
      //      — these are surfaced as additional spawn targets so the
      //      Terminals device picker, Grid device picker, and Chat
      //      panel all see the full federation from a satellite's POV.
      //   3. Local node entry so users can spawn ON this device too.
      const state = satellite.getState?.() ?? "disconnected";
      const localNode = await getLocalNode();
      // localNode.role defaults to "standalone" because no hub here;
      // override to "satellite" since we're connected to master.
      localNode.role = "satellite";

      const peers = satellite.getFederatedNodes?.() ?? [];
      // Same paired-displayName overlay as the master branch — a peer
      // satellite may have been renamed on master; reflect that here.
      const pairedPeerNames = new Map<string, string>();
      try {
        const { paired } = await listNodePairing();
        for (const p of paired) {
          if (p?.nodeId && p.displayName) pairedPeerNames.set(p.nodeId, p.displayName);
        }
      } catch {
        /* best-effort */
      }
      const localId = localNode.id;
      const masterId = String(
        (satellite as unknown as { manifest?: { masterId?: string } })?.manifest?.masterId ??
          "master",
      );
      const peerNodes = peers
        .filter((n) => n && typeof n.id === "string" && n.id !== localId && n.id !== masterId)
        .map((n) => {
          // NodeManifest doesn't carry a `role` field — synthesize one
          // from the manifest shape: anything labeled "master" is the
          // hub, everything else is a peer satellite.
          const anyN = n as unknown as { role?: string; isHub?: boolean };
          const role: string =
            anyN.role === "master" || anyN.isHub === true ? "master" : "satellite";
          return {
            id: n.id,
            name: pairedPeerNames.get(n.id) ?? n.name ?? n.id,
            status: "online" as const,
            role,
            isLocal: false,
            capabilities: n.capabilities,
            platform: (n.capabilities as { platform?: string } | undefined)?.platform,
            lastSeen: Date.now(),
            // Same URL semantics as the master-side branch — see comment
            // above. Mobile reads `url` first, then derives the HTTP
            // base via `nodeHttpBase`.
            url: satelliteReachableUrl(n),
            gatewayUrl: n.gatewayUrl ?? null,
          };
        });

      opts.respond(true, {
        success: true,
        role: "satellite",
        nodes: [
          localNode,
          {
            id: "master",
            name: "Master",
            url: config.federation?.masterUrl ?? "",
            status: state,
            role: "master",
            isLocal: false,
          },
          ...peerNodes,
        ],
      });
      return;
    }

    // Standalone mode - still show local node
    const localNode = await getLocalNode();
    opts.respond(true, {
      success: true,
      role: "standalone",
      nodes: [localNode],
    });
  },

  /**
   * Link a connected federation node to the SSH device registry so the
   * agentic `ssh_devices` tool (and the SSH Devices UI view) can target
   * it directly. Uses the node's federation manifest for hostname
   * defaults, but lets the caller override host/port (e.g. supply a
   * tailnet DNS name instead of a LAN IP).
   *
   * Idempotent: keyed by name `fed-<nodeId>` so re-running with new
   * credentials updates the existing entry instead of duplicating.
   * Available on master OR standalone (the local store) so the linker
   * works whether the operator is at the master or running an MCP-only
   * agent on a satellite that wants to remember neighbors.
   */
  "federation.node.linkSshDevice": async (opts: GatewayRequestHandlerOptions) => {
    const params = (opts.params ?? {}) as Record<string, unknown>;
    const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
    const username = typeof params.username === "string" ? params.username.trim() : "";
    if (!nodeId || !username) {
      opts.respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "nodeId and username are required",
      });
      return;
    }
    const hostOverride =
      typeof params.host === "string" && params.host.trim() ? params.host.trim() : undefined;
    const port =
      typeof params.port === "number" && Number.isFinite(params.port) && params.port > 0
        ? Math.floor(params.port)
        : 22;
    const password = typeof params.password === "string" ? params.password : undefined;
    const privateKey = typeof params.privateKey === "string" ? params.privateKey : undefined;
    const setActive = params.setActive === true;

    try {
      const hub = getFederationHub();
      let manifestHost: string | undefined;
      let manifestName: string | undefined;
      if (hub) {
        const node = hub.getConnectedNodes().find((n) => n.id === nodeId);
        if (node?.manifest) {
          manifestHost = node.manifest.hostname;
          manifestName = node.manifest.name;
        }
      }
      const host = hostOverride ?? manifestHost;
      if (!host) {
        opts.respond(false, undefined, {
          code: "NOT_FOUND",
          message: `no host found for nodeId=${nodeId}; pass an explicit \`host\` param`,
        });
        return;
      }

      const { resolve } = await import("node:path");
      const { getSSHDeviceStore } = await import("../../ssh-devices/store.js");
      const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
      const store = getSSHDeviceStore(resolve(stateDir));
      const friendlyName = `fed-${nodeId}`;

      const existing = store.getByName(friendlyName);
      const tagSet = new Set<string>(existing?.tags ?? []);
      tagSet.add("federation");
      const description =
        `Linked from federation node ${manifestName ?? nodeId}` +
        (hostOverride ? " (host override)" : "");

      const baseFields = {
        name: friendlyName,
        ip: host,
        port,
        username,
        password,
        privateKey,
        description,
        tags: Array.from(tagSet),
        hostname: manifestHost ?? host,
      };

      const device = existing
        ? store.update(existing.id, baseFields)
        : store.create({
            ...baseFields,
            isOnline: false,
          });

      if (!device) {
        opts.respond(false, undefined, {
          code: "INTERNAL_ERROR",
          message: "failed to upsert ssh device",
        });
        return;
      }
      if (setActive) store.setActiveDevice?.(device.id);

      opts.respond(true, {
        success: true,
        device: { ...device, password: device.password ? "***" : undefined },
      });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Generate a short-lived invite bundle that a satellite can use to auto-connect.
   *
   * The bundle is a base64-encoded JSON object (v1) containing:
   *   hubUrl, hubUrls[], hubName, token (SatelliteToken), expiresAt, generatedAt
   *
   * Tokens are valid for `expiresInMinutes` (default 15). Single-use enforcement
   * is not implemented — the current SatelliteToken system does not track consumed
   * tokens. The short TTL is the primary protection against replay; rotate the
   * hub's security singleton (gateway restart) to invalidate all outstanding tokens.
   *
   * Only callable when this node is running as a master.
   */
  "federation.generateInvite": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      expiresInMinutes: z.number().min(1).max(60).optional(),
      permissions: z.enum(["full", "spawn-only", "read-only"]).optional(),
      // Operator-chosen name for the joining satellite. 1–48 chars; trimmed.
      // When omitted the satellite keeps its own existing name (back-compat).
      satelliteName: z.string().trim().min(1).max(48).optional(),
    });
    const {
      expiresInMinutes = 15,
      permissions = "full",
      satelliteName,
    } = schema.parse(opts.params ?? {});

    const hub = getFederationHub();
    if (!hub) {
      const cfg = loadConfig();
      const configuredMode = cfg.federation?.mode ?? "standalone";
      const message =
        configuredMode === "master"
          ? "Federation hub is not running. Restart the gateway so the hub binds to /federation, then try again."
          : `Invite links can only be generated from a master node (current mode: ${configuredMode}).`;
      opts.respond(false, undefined, { code: "NOT_MASTER", message });
      return;
    }

    // Collect all available hub URLs (same logic as federation.urls)
    const config = loadConfig();
    const port = config.gateway?.port ?? 47913;
    const hubName = config.federation?.nodeName ?? os.hostname();
    const urls = await collectHubUrlCandidates(port);

    // Create a short-lived satellite token
    const { getFederationSecurity, DEFAULT_PERMISSIONS } =
      await import("../../federation/security.js");
    const security = getFederationSecurity();
    const satelliteId = randomBytes(8).toString("hex");
    const permLevel = permissions as "full" | "spawn-only" | "read-only";
    const token = security.createSatelliteToken(
      satelliteId,
      DEFAULT_PERMISSIONS[permLevel],
      expiresInMinutes / 60,
    );

    const expiresAt = token.expiresAt ?? Date.now() + expiresInMinutes * 60_000;

    // v1 invite bundle
    const bundle = {
      v: 1,
      hubUrl: urls[0].url,
      hubUrls: urls,
      hubName,
      // The name the satellite should adopt when it pairs (web-paste flow).
      // Undefined for unnamed invites — satellite keeps its current name.
      satelliteName,
      token,
      expiresAt,
      generatedAt: Date.now(),
    };

    const invite = Buffer.from(JSON.stringify(bundle)).toString("base64");

    // Also mint a CLI-compatible invite (infinibot-invite-v1:…) per URL so the
    // master UI can show a copy-paste `infinibot federation join …` command
    // for whichever address the operator picks. The CLI decoder
    // (`src/federation/invite.ts`) needs `masterUrl` + `satelliteToken` +
    // `iss` + `expiresAt`, which is a different schema from the hub bundle
    // above. Both are returned for backward compatibility.
    const cliInvites = urls.map((u) => {
      try {
        return {
          urlLabel: u.label,
          url: u.url,
          encoded: encodeInvite({
            v: 1,
            masterUrl: u.url,
            satelliteToken: token,
            satelliteIdHint: satelliteId,
            satelliteName,
            label: hubName,
            expiresAt,
            iss: hubName,
          }),
        };
      } catch {
        return { urlLabel: u.label, url: u.url, encoded: "" };
      }
    });

    opts.respond(true, {
      invite,
      expiresAt,
      hubUrls: urls,
      hubName,
      satelliteName,
      expiresInMinutes,
      cliInvites,
    });
  },

  /**
   * Get federation connection URLs for this master
   * Returns all available URLs satellites can use to connect
   */
  "federation.urls": async (opts: GatewayRequestHandlerOptions) => {
    const config = loadConfig();
    const port = config.gateway?.port ?? 47913;
    const urls = await collectHubUrlCandidates(port);

    opts.respond(true, {
      success: true,
      port,
      urls,
    });
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Federation Resources - Cross-node data sharing
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get shared projects across federation
   */
  "federation.resources.projects": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const store = getKanbanStore(stateDir);

    // Get local projects
    const allProjects = await store.getProjects();
    const allTasks = await store.getTasks();
    const localProjects = allProjects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: "active",
      sourceNode: "local",
      nodeName: "This Node",
      taskCount: allTasks.filter((t) => t.projectId === p.id).length,
      sharedWith: [],
      lastSync: Date.now(),
      syncStatus: "synced",
    }));

    const projects = [...localProjects];

    // Get projects from connected satellite nodes
    if (hub) {
      const nodes = hub.getConnectedNodes?.() ?? [];
      for (const node of nodes) {
        try {
          // Query node for its projects (simplified - real impl would use node invoke)
          const nodeProjects = node.manifest?.capabilities?.workspaces ?? [];
          // For now, just add placeholder - real implementation would fetch actual data
        } catch {
          // Node might not respond
        }
      }
    }

    opts.respond(true, { projects });
  },

  /**
   * Get shared tasks across federation
   */
  "federation.resources.tasks": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const store = getKanbanStore(stateDir);

    // Get local tasks
    const allTasks = await store.getTasks();
    const localTasks = allTasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority ?? "medium",
      projectId: t.projectId,
      sourceNode: "local",
      nodeName: "This Node",
      assignedAgent: t.assignee,
      lastSync: Date.now(),
      syncStatus: "synced",
    }));

    opts.respond(true, { tasks: localTasks });
  },

  /**
   * Get agents across federation
   */
  "federation.resources.agents": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    const config = loadConfig();

    // Get local agents
    const localAgents = (config.agents?.list ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      nodeId: "local",
      nodeName: "This Node",
      isDefault: a.default ?? false,
      status: "idle",
      activeSessions: 0,
      lastSeen: Date.now(),
    }));

    const agents = [...localAgents];

    // Get agents from connected nodes
    if (hub) {
      const nodes = hub.getConnectedNodes?.() ?? [];
      for (const node of nodes) {
        const nodeAgents = node.manifest?.capabilities?.agents ?? [];
        for (const agentId of nodeAgents) {
          agents.push({
            id: agentId,
            name: undefined,
            nodeId: node.id,
            nodeName: node.manifest?.name ?? node.id,
            isDefault: false,
            status: node.state === "registered" ? "idle" : "offline",
            activeSessions: node.activeSessions ?? 0,
            lastSeen: node.lastHeartbeat ?? Date.now(),
          });
        }
      }
    }

    opts.respond(true, { agents });
  },

  /**
   * Get MCP servers across federation
   */
  "federation.resources.mcp": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();
    const config = loadConfig();
    const nodeName = config.federation?.nodeName ?? os.hostname();

    const servers: Array<{
      id: string;
      name: string;
      description: string | undefined;
      nodeId: string;
      nodeName: string;
      status: string;
      tools: string[];
      sharedToFederation: boolean;
      lastSeen: number;
      source?: string;
      config?: Record<string, unknown>;
    }> = [];

    // Get local MCP servers from config files
    try {
      const { discoverLocalMCPServers } = await import("../../mcp/local-discovery.js");
      const localMCPs = discoverLocalMCPServers();

      for (const mcp of localMCPs) {
        servers.push({
          id: mcp.id,
          name: mcp.name,
          description: mcp.description,
          nodeId: "local",
          nodeName: nodeName,
          status: mcp.status,
          tools: [],
          sharedToFederation: true,
          lastSeen: Date.now(),
          source: mcp.source,
          config: {
            command: mcp.config.command,
            args: mcp.config.args,
          },
        });
      }
    } catch {
      // Local MCP discovery failed - continue with remote MCPs
    }

    // Get MCPs from connected satellite nodes
    if (hub) {
      const nodes = hub.getConnectedNodes?.() ?? [];
      for (const node of nodes) {
        const nodeMCPs = node.manifest?.capabilities?.mcpServers ?? [];
        for (const mcpName of nodeMCPs) {
          servers.push({
            id: `${node.id}:${mcpName}`,
            name: mcpName,
            description: undefined,
            nodeId: node.id,
            nodeName: node.manifest?.name ?? node.id,
            status: "unknown",
            tools: [],
            sharedToFederation: true,
            lastSeen: node.lastHeartbeat ?? Date.now(),
          });
        }
      }
    }

    opts.respond(true, { servers });
  },

  /**
   * Get business data sources across federation
   */
  "federation.resources.business": async (opts: GatewayRequestHandlerOptions) => {
    // Return default local business sources
    opts.respond(true, {
      sources: [
        {
          id: "local-income",
          type: "income",
          name: "Income Streams",
          nodeId: "local",
          nodeName: "This Node",
          sharedToFederation: true,
          lastSync: Date.now(),
          status: "synced",
        },
      ],
    });
  },

  /**
   * Aggregate /directories registry entries from every connected federation
   * node so the user can pick a directory belonging to any device when
   * spawning a terminal. Local entries are always returned; remote entries
   * are pulled from each satellite's manifest if it advertised them at
   * registration time. Cross-node *live* querying of directories.list on a
   * satellite requires functional cross-node RPC — once that's wired, this
   * handler is the single place that needs to swap the manifest source for
   * an invokeNodeMethod loop.
   */
  "federation.resources.directories": async (opts: GatewayRequestHandlerOptions) => {
    const localNodeName = (() => {
      try {
        const cfg = loadConfig();
        return cfg.federation?.nodeName || os.hostname() || "This Node";
      } catch {
        return os.hostname() || "This Node";
      }
    })();

    type FederatedDirectory = {
      id: string;
      name: string;
      path: string;
      icon?: string;
      description?: string;
      agentId?: string;
      projectId?: string;
      tags?: string[];
      gitRemote?: string;
      active: boolean;
      sourceNode: string;
      nodeName: string;
      syncStatus: "synced" | "stale";
      lastSync: number;
    };

    const out: FederatedDirectory[] = [];

    // ── Local entries ──
    try {
      const localStore = getDirectoryStore(resolveStateDir());
      const localEntries = localStore.list({ active: true });
      for (const e of localEntries) {
        out.push({
          id: e.id,
          name: e.name,
          path: e.path,
          icon: e.icon,
          description: e.description,
          agentId: e.agentId,
          projectId: e.projectId,
          tags: e.tags,
          gitRemote: e.gitRemote,
          active: e.active,
          sourceNode: "local",
          nodeName: localNodeName,
          syncStatus: "synced",
          lastSync: Date.now(),
        });
      }
    } catch (err) {
      // Don't fail the federated query on local-store issues — log and
      // continue with whatever we can get from satellites.
      console.warn("[federation.resources.directories] local store failed:", err);
    }

    // ── Remote entries (best-effort; live-RPC is a TODO) ──
    const hub = getFederationHub();
    if (hub) {
      const nodes: ConnectedNode[] = hub.getConnectedNodes?.() ?? [];
      for (const node of nodes) {
        const manifestDirs = (node.manifest as any)?.directories;
        if (!Array.isArray(manifestDirs)) continue;
        const nodeName = node.manifest?.name ?? node.id;
        const lastSeen = (node as any).lastHeartbeat ?? Date.now();
        const isStale = Date.now() - lastSeen > 60_000;
        for (const d of manifestDirs) {
          if (!d || typeof d !== "object" || !d.path) continue;
          out.push({
            id: typeof d.id === "string" ? d.id : `${node.id}:${d.path}`,
            name: typeof d.name === "string" ? d.name : d.path,
            path: String(d.path),
            icon: typeof d.icon === "string" ? d.icon : undefined,
            description: typeof d.description === "string" ? d.description : undefined,
            agentId: typeof d.agentId === "string" ? d.agentId : undefined,
            projectId: typeof d.projectId === "string" ? d.projectId : undefined,
            tags: Array.isArray(d.tags) ? d.tags : undefined,
            gitRemote: typeof d.gitRemote === "string" ? d.gitRemote : undefined,
            active: d.active !== false,
            sourceNode: node.id,
            nodeName,
            syncStatus: isStale ? "stale" : "synced",
            lastSync: lastSeen,
          });
        }
      }
    }

    opts.respond(true, { directories: out });
  },

  /**
   * Get gateway info for a specific node
   */
  "federation.node.gateway": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({ nodeId: z.string() });
    const { nodeId } = schema.parse(opts.params);

    const hub = getFederationHub();
    if (!hub) {
      opts.respond(false, undefined, { code: "NOT_MASTER", message: "Not a federation master" });
      return;
    }

    const node = hub.getNode?.(nodeId);
    if (!node) {
      opts.respond(false, undefined, { code: "NOT_FOUND", message: `Node ${nodeId} not found` });
      return;
    }

    opts.respond(true, {
      info: {
        nodeId: node.id,
        name: node.manifest?.name ?? node.id,
        hostname: node.manifest?.hostname,
        port: node.manifest?.port ?? 18789,
        connected: node.state === "registered",
        capabilities: node.manifest?.capabilities,
      },
    });
  },

  /**
   * Invoke a method on a remote node
   */
  "federation.node.invoke": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      nodeId: z.string(),
      method: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    });
    const { nodeId, method, params } = schema.parse(opts.params);

    const hub = getFederationHub();
    if (!hub) {
      // No local hub means this gateway isn't running as a master. Two
      // cases to handle before we give up:
      //   1. The UI on a SATELLITE gateway targets `nodeId === "master"`
      //      from a federation device picker (grid, terminals top-nav).
      //      Tunnel the RPC up to the master via the satellite's WS so
      //      the master executes it and the result flows back. Without
      //      this branch the UI gets "this device is not master" instead
      //      of being able to talk to its master at all.
      //   2. Any other nodeId on a non-master device: still no path —
      //      fall through to the NOT_MASTER error.
      if (nodeId === "master") {
        const satellite = getFederationSatellite();
        if (satellite && satellite.getState() === "connected") {
          // Method-name translation. `session.send` and `session.spawn` are
          // pseudo-methods that ONLY exist inside `federation.node.invoke`'s
          // master-side special-case logic (they're aliases for the hub's
          // `sendRemoteMessage` / `spawnRemoteSession` plumbing) — they
          // aren't registered as standalone gateway handlers. When we
          // tunnel up to master via `master.gateway.invoke`, the master's
          // dispatcher (handleMasterGatewayInvoke) only looks in the
          // registered coreGatewayHandlers map, so it can't find them and
          // returns `master has no handler for session.send`. Translate to
          // the master-local handler names that actually exist:
          //   session.send   → agent  (delivers a message to a sessionKey)
          //   session.spawn  → sessions.spawn (creates a new session)
          let masterMethod = method;
          if (method === "session.send") masterMethod = "agent";
          else if (method === "session.spawn") masterMethod = "sessions.spawn";
          try {
            const result = await satellite.invokeOnMaster(masterMethod, params ?? {});
            if (result.success) {
              opts.respond(true, { status: "ok", payload: result.data });
            } else {
              opts.respond(true, {
                status: "error",
                error: result.error?.message ?? "master invoke failed",
                code: result.error?.code,
              });
            }
          } catch (err) {
            opts.respond(false, undefined, {
              code: "MASTER_INVOKE_FAILED",
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        opts.respond(false, undefined, {
          code: "MASTER_UNAVAILABLE",
          message: "Master gateway not reachable from this satellite. Reconnect first, then retry.",
        });
        return;
      }
      opts.respond(false, undefined, { code: "NOT_MASTER", message: "Not a federation master" });
      return;
    }

    const node = hub.getNode?.(nodeId);
    if (!node || node.state !== "registered") {
      opts.respond(false, undefined, {
        code: "NOT_CONNECTED",
        message: `Node ${nodeId} not connected`,
      });
      return;
    }

    try {
      // Route to appropriate hub method based on method type
      if (method === "agent" || method === "session.spawn") {
        // Agent spawn request - use hub's spawnRemoteSession
        const spawnParams = params as {
          message?: string;
          task?: string;
          agentId?: string;
          label?: string;
          thinking?: string;
          timeout?: number;
          idempotencyKey?: string;
        };

        try {
          const handle = await hub.spawnRemoteSession({
            nodeId,
            agentId: spawnParams.agentId || "coder",
            task: spawnParams.message || spawnParams.task || "",
            label: spawnParams.label,
            thinking: spawnParams.thinking,
            runTimeoutSeconds: spawnParams.timeout,
          });

          opts.respond(true, {
            status: "ok",
            childSessionKey: handle.sessionKey,
            runId: handle.runId,
            node: handle.nodeId,
          });
        } catch (spawnErr) {
          const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          opts.respond(true, {
            status: "error",
            error: errMsg,
          });
        }
      } else if (method === "session.send") {
        // Session message request - use hub's sendRemoteMessage
        const sendParams = params as {
          sessionKey?: string;
          message?: string;
          timeout?: number;
        };

        const result = await hub.sendRemoteMessage({
          nodeId,
          sessionKey: sendParams.sessionKey || "",
          message: sendParams.message || "",
          timeoutSeconds: sendParams.timeout,
        });

        opts.respond(true, {
          status: result.success ? "ok" : "error",
          reply: result.reply,
          error: result.error,
        });
      } else {
        // Generic gateway proxy — forward an arbitrary RPC to the satellite's
        // local gateway. This is what powers cross-device PTY: terminal.create,
        // terminal.write, terminal.getBuffer, terminal.resize, terminal.destroy
        // all flow through here and execute on the satellite.
        const hubAny = hub as unknown as {
          invokeOnNode: (
            n: string,
            cmd: string,
            p: unknown,
            ms?: number,
          ) => Promise<{ success: boolean; reply?: string; error?: string }>;
        };
        const proxyRes = await hubAny.invokeOnNode(
          nodeId,
          "gateway.proxy.invoke",
          { method, params },
          30_000,
        );
        if (!proxyRes.success) {
          opts.respond(false, undefined, {
            code: "INVOKE_FAILED",
            message: proxyRes.error ?? "remote invoke failed",
          });
          return;
        }
        // The satellite encodes its arbitrary RPC payload as a JSON string in
        // `reply` to fit handleInvokeResponse's existing SessionResult shape.
        let parsedPayload: unknown = null;
        if (typeof proxyRes.reply === "string") {
          try {
            parsedPayload = JSON.parse(proxyRes.reply);
          } catch {
            parsedPayload = proxyRes.reply;
          }
        }
        opts.respond(true, {
          status: "ok",
          method,
          payload: parsedPayload,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      opts.respond(false, undefined, { code: "INVOKE_FAILED", message: errorMsg });
    }
  },

  /**
   * Full sync across federation
   */
  "federation.sync": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();

    if (!hub) {
      opts.respond(true, { success: true, synced: 0 });
      return;
    }

    const nodes = hub.getConnectedNodes?.() ?? [];
    let synced = 0;

    for (const node of nodes) {
      try {
        // Placeholder - real impl would sync data with each node
        synced++;
      } catch {
        // Node sync failed
      }
    }

    opts.respond(true, { success: true, synced });
  },

  /**
   * Share project to federation
   */
  "federation.share.project": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      projectId: z.string(),
      targetNodes: z.array(z.string()).optional(),
    });
    const { projectId, targetNodes } = schema.parse(opts.params);

    // Placeholder - real impl would broadcast project to target nodes
    opts.respond(true, { success: true, projectId, sharedTo: targetNodes ?? [] });
  },

  /**
   * Assign task to a node/agent
   */
  "federation.assign.task": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      taskId: z.string(),
      nodeId: z.string(),
      agentId: z.string().optional(),
    });
    const { taskId, nodeId, agentId } = schema.parse(opts.params);

    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const store = getKanbanStore(stateDir);

    // Update local task
    if (agentId) {
      await store.updateTask(taskId, { assignee: agentId });
    }

    opts.respond(true, { success: true, taskId, nodeId, agentId });
  },

  /**
   * Share/unshare MCP to federation
   */
  "federation.share.mcp": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      mcpId: z.string(),
      share: z.boolean(),
    });
    const { mcpId, share } = schema.parse(opts.params);

    // Placeholder - real impl would update MCP sharing config
    opts.respond(true, { success: true, mcpId, shared: share });
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Federation MCP Proxy - Cross-node MCP invocation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * List all MCP servers available across the federation
   */
  "federation.mcp.list": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      nodeId: z.string().optional(),
    });
    const { nodeId } = schema.parse(opts.params ?? {});

    try {
      const result = await listFederationMCPs(nodeId);
      opts.respond(true, result);
    } catch (err) {
      opts.respond(false, undefined, {
        code: "MCP_LIST_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Find which node owns an MCP server
   */
  "federation.mcp.find": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      mcpName: z.string(),
    });
    const { mcpName } = schema.parse(opts.params);

    const result = findMCPNode(mcpName);
    if (result) {
      opts.respond(true, { found: true, ...result });
    } else {
      opts.respond(true, { found: false, mcpName });
    }
  },

  /**
   * Invoke an MCP tool across the federation
   *
   * This transparently routes to the appropriate node:
   * - Local MCPs are called directly
   * - Remote MCPs are routed via federation hub/satellite
   */
  "federation.mcp.invoke": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      mcpName: z.string(),
      tool: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
      targetNodeId: z.string().optional(),
    });
    const { mcpName, tool, args, targetNodeId } = schema.parse(opts.params);

    try {
      const result = await invokeMCP(mcpName, tool, args ?? {}, targetNodeId);

      if (result.success) {
        opts.respond(true, {
          success: true,
          result: result.result,
          sourceNodeId: result.sourceNodeId,
        });
      } else {
        opts.respond(true, {
          success: false,
          error: result.error,
          sourceNodeId: result.sourceNodeId,
        });
      }
    } catch (err) {
      opts.respond(false, undefined, {
        code: "MCP_INVOKE_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Get MCP description formatted for agent system prompts
   */
  "federation.mcp.description": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const description = await getMCPDescriptionForAgent();
      opts.respond(true, { description });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "MCP_DESCRIPTION_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Compute Routing - Capability-aware task routing
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Analyze a task description to determine routing requirements.
   * Returns capability requirements and suggested node for the task.
   * Used by the spawn dialog to show routing indicators.
   */
  "compute.analyzeTask": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      task: z.string(),
    });
    const { task } = schema.parse(opts.params);

    try {
      const service = getComputeRoutingService();
      const analysis = service.analyzeTaskForUI(task);

      opts.respond(true, {
        needsGPU: analysis.needsGPU,
        needsOllama: analysis.needsOllama,
        needsVoice: analysis.needsVoice,
        needsMCP: analysis.needsMCP,
        suggestedNode: analysis.suggestedNode,
        taskType: analysis.taskType,
      });
    } catch {
      // If compute routing service not initialized, return defaults
      opts.respond(true, {
        needsGPU: false,
        needsOllama: false,
        needsVoice: false,
        needsMCP: [],
        suggestedNode: undefined,
        taskType: "unknown",
      });
    }
  },

  /**
   * Get the best node for spawning a session.
   * Uses capability-aware routing to select the optimal node.
   */
  "compute.routeSpawn": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      task: z.string(),
      agentId: z.string().optional(),
      workspace: z.string().optional(),
      preferNode: z.string().optional(),
    });
    const { task, agentId, workspace, preferNode } = schema.parse(opts.params);

    try {
      const service = getComputeRoutingService();
      const result = await service.routeSpawnEnhanced({
        task,
        agentId,
        workspace,
        preferNode,
      });

      opts.respond(true, {
        nodeId: result.nodeId,
        nodeName: result.nodeName,
        reason: result.reason,
        confidence: result.confidence,
        isRemote: result.isRemote,
        autoRouted: result.autoRouted,
        alternatives: result.alternatives,
        requirements: result.requirements,
      });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "ROUTING_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Federation Updates - Cross-node update management
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get version info from a specific node
   * If nodeId is "local" or omitted, returns local version
   */
  "federation.node.version": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      nodeId: z.string().optional(),
    });
    const { nodeId } = schema.parse(opts.params ?? {});

    const hub = getFederationHub();

    // If asking for local version
    if (!nodeId || nodeId === "local") {
      // Get version info from package.json
      const { getLocalVersionInfo } = await import("../../infra/version-info.js");
      const info = await getLocalVersionInfo();

      opts.respond(true, {
        nodeId: "local",
        nodeName: os.hostname(),
        isLocal: true,
        info,
      });
      return;
    }

    // If we're a master and asking for a satellite's version
    if (hub) {
      const node = hub.getNode?.(nodeId);
      if (!node || node.state !== "registered") {
        opts.respond(true, {
          success: false,
          error: `Node ${nodeId} not connected`,
          nodeId,
        });
        return;
      }

      // Return manifest info as a fallback (satellites report version in manifest)
      const caps = node.manifest?.capabilities as unknown as Record<string, unknown> | undefined;
      opts.respond(true, {
        nodeId,
        nodeName: node.manifest?.name ?? nodeId,
        isLocal: false,
        info: {
          version: caps?.version ?? "unknown",
          hostname: node.manifest?.hostname,
          platform: caps?.platform ?? node.manifest?.capabilities.platform,
          arch: caps?.arch ?? node.manifest?.capabilities.arch,
          connected: true,
          lastHeartbeat: node.lastHeartbeat,
        },
      });
      return;
    }

    opts.respond(true, {
      success: false,
      error: "Not connected to federation",
    });
  },

  /**
   * Get versions from all nodes in the federation
   * Returns local version plus all connected node versions
   */
  "federation.fleet.versions": async (opts: GatewayRequestHandlerOptions) => {
    const hub = getFederationHub();

    // Get local version first
    const { getLocalVersionInfo } = await import("../../infra/version-info.js");
    const localInfo = await getLocalVersionInfo();

    const nodes: Array<{
      nodeId: string;
      nodeName: string;
      isLocal: boolean;
      isMaster: boolean;
      status: "online" | "offline";
      version: string;
      buildTime: string | null;
      gitCommit: string | null;
      lastUpdated: number | null;
      updateAvailable: boolean;
    }> = [
      {
        nodeId: "local",
        nodeName: localInfo.hostname ?? os.hostname(),
        isLocal: true,
        isMaster: !!hub,
        status: "online",
        version: localInfo.version ?? "unknown",
        buildTime: localInfo.buildTime ?? null,
        gitCommit: localInfo.gitCommit ?? null,
        lastUpdated: null,
        updateAvailable: false,
      },
    ];

    // Add connected satellite nodes
    if (hub) {
      const connectedNodes = hub.getConnectedNodes?.() ?? [];
      for (const node of connectedNodes) {
        const caps = node.manifest?.capabilities as unknown as Record<string, unknown> | undefined;
        nodes.push({
          nodeId: node.id,
          nodeName: node.manifest?.name ?? node.id,
          isLocal: false,
          isMaster: false,
          status: node.state === "registered" ? "online" : "offline",
          version: (caps?.version as string) ?? "unknown",
          buildTime: null,
          gitCommit: null,
          lastUpdated: null,
          updateAvailable: false, // TODO: Compare versions to determine
        });
      }
    }

    // Determine latest version across all nodes
    const versions = nodes.map((n) => n.version).filter((v) => v !== "unknown");
    const latestVersion = versions.length > 0 ? versions.sort().reverse()[0] : null;

    // Mark nodes with outdated versions
    if (latestVersion) {
      for (const node of nodes) {
        if (node.version !== "unknown" && node.version !== latestVersion) {
          node.updateAvailable = true;
        }
      }
    }

    opts.respond(true, {
      nodes,
      latestVersion,
      timestamp: Date.now(),
    });
  },

  /**
   * Trigger update on a specific node
   * For local node: calls update.run directly
   * For remote nodes: forwards update command via federation
   */
  "federation.node.update": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      nodeId: z.string(),
      actions: z
        .object({
          gitPull: z.boolean().optional(),
          npmInstall: z.boolean().optional(),
          build: z.boolean().optional(),
          restart: z.boolean().optional(),
        })
        .optional(),
      /** Satellites: git ref to pull (validated on the satellite; default "main"). */
      branch: z.string().optional(),
    });
    const { nodeId, actions, branch } = schema.parse(opts.params);

    const hub = getFederationHub();

    // If updating local node
    if (nodeId === "local") {
      // Import and call the update runner directly
      const { runGatewayUpdate } = await import("../../infra/update-runner.js");
      const { resolveInfiniBotPackageRoot } = await import("../../infra/infinibot-root.js");

      try {
        const root =
          (await resolveInfiniBotPackageRoot({
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          })) ?? process.cwd();

        const result = await runGatewayUpdate({
          cwd: root,
          argv1: process.argv[1],
        });

        // Schedule restart if requested
        if (actions?.restart && result.status === "ok") {
          const { scheduleGatewaySigusr1Restart } = await import("../../infra/restart.js");
          scheduleGatewaySigusr1Restart({ delayMs: 2000, reason: "federation.node.update" });
        }

        opts.respond(true, {
          nodeId: "local",
          success: result.status === "ok",
          result,
        });
      } catch (err) {
        opts.respond(true, {
          nodeId: "local",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // If we're a master updating a satellite
    if (hub) {
      const node = hub.getNode?.(nodeId);
      if (!node || node.state !== "registered") {
        opts.respond(true, {
          success: false,
          error: `Node ${nodeId} not connected`,
          nodeId,
        });
        return;
      }

      // Same path as federation.fleet.update, for one node: the satellite's
      // system.update handler runs git pull origin <branch>, npm run build and
      // restarts. (This used to answer "sent" without sending anything.)
      const fleet = await hub.broadcastFleetUpdate({
        nodeIds: [nodeId],
        skipBuild: actions?.build === false,
        branch,
      });
      const sent = fleet.sent.length > 0;
      opts.respond(true, {
        nodeId,
        success: sent,
        message: sent
          ? `Update command sent to ${node.manifest?.name ?? nodeId}: it will git pull origin ${branch ?? "main"}, build and restart.`
          : undefined,
        error: sent
          ? undefined
          : `Could not send the update command to ${node.manifest?.name ?? nodeId}`,
        actions,
        branch: branch ?? "main",
      });
      return;
    }

    opts.respond(true, {
      success: false,
      error: "Not connected to federation",
    });
  },

  /**
   * Promote a satellite to master and demote the current master to satellite.
   * Orchestrates: send role.change → satellite, update local config, stop hub,
   * start satellite connection, schedule restart.
   */
  "federation.node.promote-to-master": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({ nodeId: z.string() });
    const { nodeId } = schema.parse(opts.params);

    const hub = getFederationHub();
    if (!hub) {
      opts.respond(true, { success: false, error: "Not running as master" });
      return;
    }

    const node = hub.getNode?.(nodeId);
    if (!node || node.state !== "registered") {
      opts.respond(true, { success: false, error: `Node ${nodeId} not connected` });
      return;
    }

    // Build the new master URL from the satellite's manifest. Never fall
    // back to localhost here — that would silently point every other node
    // at an unreachable address once this satellite becomes master.
    const manifest = node.manifest;
    const port = manifest.port ?? 47913;
    const newMasterUrl = satelliteReachableUrl(manifest);
    if (!newMasterUrl) {
      opts.respond(true, {
        success: false,
        error: `Node ${nodeId} did not advertise a reachable hostname/gatewayUrl; cannot promote it to master.`,
      });
      return;
    }

    // 1. Send role.change to the satellite telling it to become master
    const sent = hub.sendRoleChange(nodeId, {
      newRole: "master",
      federationPort: port,
    });
    if (!sent) {
      opts.respond(true, { success: false, error: "Failed to send role.change message" });
      return;
    }

    // Give the satellite a moment to receive the message before we tear down
    await new Promise((r) => setTimeout(r, 500));

    // 2. Update local config: demote self to satellite, point at new master
    const config = loadConfig();
    if (!config.federation) {
      (config as Record<string, unknown>).federation = { mode: "satellite" as const };
    }
    config.federation!.mode = "satellite";
    config.federation!.masterUrl = newMasterUrl;
    config.federation!.enabled = true;
    await writeConfigFile(config);

    // 3. Disconnect all satellites and stop the hub
    try {
      await stopFederationHub();
    } catch {
      // Best-effort
    }

    // 4. Schedule gateway restart to reinitialize as satellite
    const { scheduleGatewaySigusr1Restart } = await import("../../infra/restart.js");
    scheduleGatewaySigusr1Restart({ delayMs: 2000, reason: "federation.role-change" });

    opts.respond(true, {
      success: true,
      newMasterUrl,
      promotedNode: nodeId,
      promotedNodeName: manifest.name ?? nodeId,
      message: "Role swap initiated. Gateway will restart as satellite.",
    });
  },

  /**
   * Trigger update on all online nodes in the federation
   */
  "federation.fleet.update": async (opts: GatewayRequestHandlerOptions) => {
    const schema = z.object({
      actions: z
        .object({
          gitPull: z.boolean().optional(),
          npmInstall: z.boolean().optional(),
          build: z.boolean().optional(),
          restart: z.boolean().optional(),
        })
        .optional(),
      excludeNodes: z.array(z.string()).optional(),
    });
    const { actions, excludeNodes } = schema.parse(opts.params ?? {});

    const hub = getFederationHub();
    const results: Array<{
      nodeId: string;
      nodeName: string;
      success: boolean;
      message?: string;
      error?: string;
    }> = [];

    // Update local node first (unless excluded)
    if (!excludeNodes?.includes("local")) {
      const { runGatewayUpdate } = await import("../../infra/update-runner.js");
      const { resolveInfiniBotPackageRoot } = await import("../../infra/infinibot-root.js");

      try {
        const root =
          (await resolveInfiniBotPackageRoot({
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          })) ?? process.cwd();

        const result = await runGatewayUpdate({
          cwd: root,
          argv1: process.argv[1],
        });

        results.push({
          nodeId: "local",
          nodeName: os.hostname(),
          success: result.status === "ok",
          message: result.status === "ok" ? "Update completed" : undefined,
          error: result.status !== "ok" ? (result.reason ?? "Update failed") : undefined,
        });
      } catch (err) {
        results.push({
          nodeId: "local",
          nodeName: os.hostname(),
          success: false,
          error: err instanceof Error ? err.message : "Update failed",
        });
      }
    }

    // Update connected satellites via broadcastFleetUpdate
    if (hub) {
      try {
        const fleetResult = await hub.broadcastFleetUpdate({
          skipBuild: actions?.build === false,
          nodeIds: excludeNodes ? undefined : undefined, // Could filter here
        });

        for (const nodeName of fleetResult.sent) {
          results.push({
            nodeId: nodeName,
            nodeName,
            success: true,
            message: "Update command sent - satellite will pull, build, restart",
          });
        }
        for (const nodeName of fleetResult.skipped) {
          results.push({
            nodeId: nodeName,
            nodeName,
            success: false,
            error: "Node not connected",
          });
        }
        for (const nodeName of fleetResult.failed) {
          results.push({
            nodeId: nodeName,
            nodeName,
            success: false,
            error: "Failed to send update command",
          });
        }
      } catch (err) {
        results.push({
          nodeId: "satellites",
          nodeName: "satellites",
          success: false,
          error: `Fleet update failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    opts.respond(true, {
      results,
      timestamp: Date.now(),
    });
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // Mesh Sync Methods — Neural Mesh Visualization Federation Support
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Broadcast mesh state to all connected nodes
   * Used by neural-mesh-viz to sync agent states across federation
   */
  "federation.broadcast": async (opts: GatewayRequestHandlerOptions) => {
    const { type, payload } = opts.params as { type?: string; payload?: unknown };

    const hub = getFederationHub();
    const satellite = getFederationSatellite();

    if (!hub && !satellite) {
      opts.respond(true, { sent: 0, reason: "No federation connection" });
      return;
    }

    let sent = 0;

    // If we're a hub, broadcast to all connected satellites via their WebSockets
    if (hub) {
      const nodes = hub.getConnectedNodes?.() ?? [];
      for (const node of nodes) {
        try {
          // Send directly via WebSocket
          const message = JSON.stringify({
            type: "mesh.sync",
            payload: {
              type: type ?? "mesh.sync",
              nodeId: os.hostname(),
              data: payload,
              timestamp: Date.now(),
            },
          });
          node.socket?.send?.(message);
          sent++;
        } catch {
          // Ignore individual node failures
        }
      }
    }

    // Satellites can't broadcast back to master in this simple impl
    // The master receives mesh state via normal event subscriptions

    opts.respond(true, { sent });
  },

  /**
   * Get mesh messages from connected nodes
   * Returns recent mesh state updates from federation
   */
  "federation.mesh.messages": async (opts: GatewayRequestHandlerOptions) => {
    const { limit = 50, since } = opts.params as { limit?: number; since?: number };

    const hub = getFederationHub();
    const messages: Array<{
      id: string;
      nodeId: string;
      nodeName: string;
      type: string;
      payload: unknown;
      timestamp: number;
    }> = [];

    // Collect recent mesh updates from connected nodes
    if (hub) {
      const nodes = hub.getConnectedNodes?.() ?? [];

      for (const node of nodes) {
        // Each node tracks its last mesh state (stored dynamically)
        const meshState = (node as any).__lastMeshState as { timestamp: number } | undefined;
        if (meshState && (!since || meshState.timestamp > since)) {
          messages.push({
            id: `mesh-${node.id}-${meshState.timestamp}`,
            nodeId: node.id,
            nodeName: node.manifest?.name ?? node.id,
            type: "mesh.sync",
            payload: meshState,
            timestamp: meshState.timestamp,
          });
        }
      }
    }

    // Sort by timestamp descending, limit
    const sorted = messages.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);

    opts.respond(true, { success: true, messages: sorted });
  },

  /**
   * Get federation mesh status for the neural mesh viz
   * Returns nodes, agents, and connection state for visualization
   * Format compatible with Android MeshMapState
   */
  "federation.mesh.status": async (opts: GatewayRequestHandlerOptions) => {
    const { includeAgents, includeCapabilities, includeLoad } =
      (opts.params as {
        includeAgents?: boolean;
        includeCapabilities?: boolean;
        includeLoad?: boolean;
      }) ?? {};

    const hub = getFederationHub();
    const satellite = getFederationSatellite();
    const config = loadConfig();
    const localNodeId = config.federation?.nodeId ?? os.hostname();
    const localNodeName = config.federation?.nodeName ?? os.hostname();

    // MeshNode interface for Android compatibility
    interface MeshNodeData {
      id: string;
      name: string;
      hostname: string;
      isMaster: boolean;
      isLocal: boolean;
      status: string;
      capabilities: {
        hasOllama: boolean;
        ollamaModels: string[];
        hasComfyUI: boolean;
        hasVoice: boolean;
        gpu: string | null;
        gpuVRAM: number | null;
        systemRAM: number | null;
        mcpServers: string[];
        agents: string[];
        platform: string | null;
        arch: string | null;
        hasCamera: boolean;
        hasScreen: boolean;
        hasLocation: boolean;
      };
      agents: Array<{
        sessionKey: string;
        agentId: string;
        label: string;
        status: string;
        progress: number;
        currentTask: string | null;
      }>;
      activeSessions: number;
      currentLoad: number;
      lastSeenMs: number;
    }

    const nodes: MeshNodeData[] = [];
    let masterNodeId: string | null = null;

    // Add local node (master or standalone)
    if (hub || !satellite) {
      masterNodeId = localNodeId;

      // Get local capabilities
      const { getLocalManifest } = await import("../../federation/compute-manifest.js");
      const localCaps = await getLocalManifest().catch(() => null);

      nodes.push({
        id: localNodeId,
        name: localNodeName,
        hostname: os.hostname(),
        isMaster: !!hub,
        isLocal: true,
        status: "online",
        capabilities: {
          hasOllama: localCaps?.hasOllama ?? false,
          ollamaModels: localCaps?.ollamaModels ?? [],
          hasComfyUI: localCaps?.hasComfyUI ?? false,
          hasVoice: localCaps?.hasVoice ?? false,
          gpu: localCaps?.gpu ?? null,
          gpuVRAM: localCaps?.gpuVRAM ?? null,
          systemRAM: localCaps?.systemRAM ?? null,
          mcpServers: localCaps?.mcpServers ?? [],
          agents: localCaps?.agents ?? [],
          platform: process.platform,
          arch: process.arch,
          hasCamera: false,
          hasScreen: true,
          hasLocation: false,
        },
        agents: [], // TODO: Get active local agents
        activeSessions: 0, // TODO: Count local sessions
        currentLoad: 0, // TODO: Get CPU load
        lastSeenMs: Date.now(),
      });
    }

    // Add connected satellite nodes (if we're master)
    if (hub) {
      const connectedNodes = hub.getConnectedNodes?.() ?? [];

      for (const node of connectedNodes) {
        const caps = node.manifest?.capabilities;

        nodes.push({
          id: node.id,
          name: node.manifest?.name ?? node.id,
          hostname: node.manifest?.hostname ?? node.id,
          isMaster: false,
          isLocal: false,
          status: node.state === "registered" ? "online" : node.state,
          capabilities: {
            hasOllama: caps?.hasOllama ?? false,
            ollamaModels: caps?.ollamaModels ?? [],
            hasComfyUI: caps?.hasComfyUI ?? false,
            hasVoice: caps?.hasVoice ?? false,
            gpu: caps?.gpu ?? null,
            gpuVRAM: caps?.gpuVRAM ?? null,
            systemRAM: caps?.systemRAM ?? null,
            mcpServers: caps?.mcpServers ?? [],
            agents: caps?.agents ?? [],
            platform: caps?.platform ?? null,
            arch: caps?.arch ?? null,
            hasCamera: false, // TODO: Check node caps
            hasScreen: false,
            hasLocation: false,
          },
          agents: (node as any).__meshAgents ?? [],
          activeSessions: node.activeSessions ?? 0,
          currentLoad: node.currentLoad ?? 0,
          lastSeenMs: node.lastHeartbeat ?? node.connectedAt ?? Date.now(),
        });
      }
    }

    // If we're a satellite, add master node
    if (satellite) {
      const masterUrl = config.federation?.masterUrl;
      masterNodeId = "master";

      nodes.unshift({
        id: "master",
        name: "Master",
        hostname: masterUrl ? new URL(masterUrl).hostname : "master",
        isMaster: true,
        isLocal: false,
        status: satellite.getState?.() === "connected" ? "online" : "offline",
        capabilities: {
          hasOllama: false, // Unknown for master from satellite perspective
          ollamaModels: [],
          hasComfyUI: false,
          hasVoice: false,
          gpu: null,
          gpuVRAM: null,
          systemRAM: null,
          mcpServers: [],
          agents: [],
          platform: null,
          arch: null,
          hasCamera: false,
          hasScreen: false,
          hasLocation: false,
        },
        agents: [],
        activeSessions: 0,
        currentLoad: 0,
        lastSeenMs: Date.now(),
      });

      // Add local satellite node
      nodes.push({
        id: localNodeId,
        name: localNodeName,
        hostname: os.hostname(),
        isMaster: false,
        isLocal: true,
        status: "online",
        capabilities: {
          hasOllama: false, // TODO: Get from local manifest
          ollamaModels: [],
          hasComfyUI: false,
          hasVoice: false,
          gpu: null,
          gpuVRAM: null,
          systemRAM: null,
          mcpServers: [],
          agents: [],
          platform: process.platform,
          arch: process.arch,
          hasCamera: false,
          hasScreen: true,
          hasLocation: false,
        },
        agents: [],
        activeSessions: 0,
        currentLoad: 0,
        lastSeenMs: Date.now(),
      });
    }

    // Response format compatible with Android MeshMapState
    opts.respond(true, {
      nodes,
      masterNodeId,
      localNodeId,
      totalAgents: nodes.reduce((sum, n) => sum + n.agents.length, 0),
      totalSessions: nodes.reduce((sum, n) => sum + n.activeSessions, 0),
      lastUpdateMs: Date.now(),
      isConnected: nodes.some((n) => n.status === "online"),
    });
  },

  /**
   * List Dead Letter Queue entries
   */
  "federation.dlq.list": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = DeadLetterFilterSchema.parse(opts.params || {});
    const dlq = getDeadLetterQueue();

    const filter: DeadLetterFilter = {
      failureReason: parsed.failureReason,
      messageType: parsed.messageType,
      sourceNodeId: parsed.sourceNodeId,
      targetNodeId: parsed.targetNodeId,
      retryable: parsed.retryable,
      newerThan: parsed.newerThan,
      olderThan: parsed.olderThan,
      limit: parsed.limit ?? 50,
      offset: parsed.offset ?? 0,
    };

    const entries = dlq.listEntries(filter);

    opts.respond(true, {
      entries: entries.map((entry) => ({
        id: entry.id,
        originalMessage: {
          type: entry.originalMessage.type,
          messageId: entry.originalMessage.messageId,
          timestamp: entry.originalMessage.timestamp,
          // Don't send full payload for security/size reasons
        },
        failureReason: entry.failureReason,
        retryCount: entry.retryCount,
        sourceNodeId: entry.sourceNodeId,
        targetNodeId: entry.targetNodeId,
        firstFailedAt: entry.firstFailedAt,
        enqueuedAt: entry.enqueuedAt,
        retryable: entry.retryable,
      })),
      filter,
      hasMore: entries.length === filter.limit,
    });
  },

  /**
   * Get Dead Letter Queue statistics
   */
  "federation.dlq.stats": async (opts: GatewayRequestHandlerOptions) => {
    const dlq = getDeadLetterQueue();
    const stats = dlq.getStats();

    opts.respond(true, { stats });
  },

  /**
   * Get specific DLQ entry with full details
   */
  "federation.dlq.get": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = z.object({ id: z.string() }).parse(opts.params);
    const dlq = getDeadLetterQueue();

    const entry = dlq.getEntry(parsed.id);
    if (!entry) {
      opts.respond(false, { error: "DLQ entry not found" });
      return;
    }

    opts.respond(true, { entry });
  },

  /**
   * Retry a failed message from DLQ
   */
  "federation.dlq.retry": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = DeadLetterRetrySchema.parse(opts.params);
    const dlq = getDeadLetterQueue();

    // Get the entry first to check if it exists
    const entry = dlq.getEntry(parsed.id);
    if (!entry) {
      opts.respond(false, { error: "DLQ entry not found" });
      return;
    }

    // For now, we'll implement a basic retry that removes the entry without actually sending
    // In a full implementation, this would need access to the federation hub/satellite
    // to actually retry sending the message

    try {
      const result = await dlq.retryEntry(parsed.id, async (message, targetNodeId) => {
        const hub = getFederationHub();
        if (hub) {
          const delivered = await hub.retryMessageToNode(targetNodeId, message);
          if (!delivered) {
            throw new Error(`target node ${targetNodeId} is not currently connected`);
          }
          return;
        }
        const satellite = getFederationSatellite();
        if (satellite) {
          const sent = await satellite.sendMessageToPeer(
            targetNodeId,
            message.type as import("../../federation/types.js").FederationMessageType,
            message.payload,
          );
          if (!sent) throw new Error(`satellite could not deliver to ${targetNodeId}`);
          return;
        }
        throw new Error("no federation hub or satellite available to retry the message");
      });

      opts.respond(true, {
        success: result.success,
        error: result.error,
      });
    } catch (error) {
      opts.respond(false, {
        error: error instanceof Error ? error.message : "Failed to retry message",
      });
    }
  },

  /**
   * Remove a DLQ entry (discard permanently)
   */
  "federation.dlq.remove": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = DeadLetterRemoveSchema.parse(opts.params);
    const dlq = getDeadLetterQueue();

    const removed = dlq.remove(parsed.id);

    opts.respond(true, {
      success: removed,
      message: removed ? "DLQ entry removed" : "DLQ entry not found",
    });
  },

  /**
   * Clear all DLQ entries
   */
  "federation.dlq.clear": async (opts: GatewayRequestHandlerOptions) => {
    const dlq = getDeadLetterQueue();
    dlq.clear();

    opts.respond(true, {
      success: true,
      message: "All DLQ entries cleared",
    });
  },

  /**
   * Clean up old DLQ entries
   */
  "federation.dlq.cleanup": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = z
      .object({
        maxAge: z.number().optional(),
      })
      .parse(opts.params || {});

    const dlq = getDeadLetterQueue();
    const removed = dlq.cleanup(parsed.maxAge);

    opts.respond(true, {
      success: true,
      entriesRemoved: removed,
      maxAge: parsed.maxAge,
    });
  },

  /**
   * federation.selection.set — Record which federation node a client device
   * is currently routing chat through. Stored in-memory keyed by deviceId so
   * other clients (web dashboard, desktop control UI) can mirror the selection.
   *
   * Used by the mobile app's FederationPicker; web reads via
   * federation.selection.get({}) without a deviceId to receive all entries.
   */
  "federation.selection.set": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = z
      .object({
        deviceId: z.string().min(1).max(64),
        nodeId: z.string().min(1).max(128),
        timestamp: z.number().optional(),
      })
      .parse(opts.params || {});

    federationSelectionStore.set(parsed.deviceId, {
      nodeId: parsed.nodeId,
      timestamp: parsed.timestamp ?? Date.now(),
    });

    opts.respond(true, {
      success: true,
      deviceId: parsed.deviceId,
      nodeId: parsed.nodeId,
    });
  },

  /**
   * federation.selection.get — Read the current per-device federation
   * selection map. Pass deviceId for a single entry, omit for all entries.
   */
  "federation.selection.get": async (opts: GatewayRequestHandlerOptions) => {
    const parsed = z
      .object({
        deviceId: z.string().optional(),
      })
      .parse(opts.params || {});

    if (parsed.deviceId) {
      const entry = federationSelectionStore.get(parsed.deviceId);
      opts.respond(true, {
        deviceId: parsed.deviceId,
        nodeId: entry?.nodeId ?? null,
        timestamp: entry?.timestamp ?? null,
      });
      return;
    }

    const entries: Array<{ deviceId: string; nodeId: string; timestamp: number }> = [];
    for (const [deviceId, value] of federationSelectionStore.entries()) {
      entries.push({ deviceId, nodeId: value.nodeId, timestamp: value.timestamp });
    }
    opts.respond(true, { entries });
  },

  /**
   * federation.directories.list — List registered file directories across
   * the entire federation.
   *
   * Returns local directories annotated with { sourceNodeId, sourceNodeName,
   * isLocal } plus live RPC results from each connected satellite's
   * directories.list handler via forwardGatewayCallToNode.
   */
  "federation.directories.list": async (opts: GatewayRequestHandlerOptions) => {
    const stateDir = resolveStateDir();
    const dirStore = getDirectoryStore(stateDir);
    const localDirs = dirStore.list();

    const cfg = loadConfig();
    const localNodeId = cfg.federation?.nodeId ?? "local";
    const localNodeName = cfg.federation?.nodeName ?? os.hostname();

    type FedDirEntry = Record<string, unknown> & {
      sourceNodeId: string;
      sourceNodeName: string;
      isLocal: boolean;
    };

    const result: FedDirEntry[] = localDirs.map((d) => ({
      ...d,
      sourceNodeId: localNodeId,
      sourceNodeName: localNodeName,
      isLocal: true,
    }));

    // ── Live RPC: directories.list on every connected satellite ──
    const hub = getFederationHub();
    let satelliteNodeCount = 0;
    if (hub) {
      const nodes = hub.getConnectedNodes?.() ?? [];
      satelliteNodeCount = nodes.length;
      for (const node of nodes) {
        if (node.state !== "registered") continue;
        try {
          const fwd = await forwardGatewayCallToNode<unknown[]>(
            node.id,
            "directories.list",
            { active: true },
            15_000,
          );
          if (fwd.success && Array.isArray(fwd.payload)) {
            const nodeName = node.manifest?.name ?? node.id;
            for (const entry of fwd.payload) {
              if (entry && typeof entry === "object") {
                result.push({
                  ...(entry as Record<string, unknown>),
                  sourceNodeId: node.id,
                  sourceNodeName: nodeName,
                  isLocal: false,
                });
              }
            }
          }
        } catch {
          // Best-effort per node
        }
      }
    }

    opts.respond(true, {
      directories: result,
      satelliteNodeCount,
      partial: false,
    });
  },
};

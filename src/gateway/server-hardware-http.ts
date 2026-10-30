/**
 * Hardware Analysis HTTP endpoints.
 *
 * Local:
 *   GET /api/hardware/stream      — SSE, emits HardwareSnapshot every 1 s
 *   GET /api/hardware/snapshot    — single JSON HardwareSnapshot
 *
 * Federation (master-only — master + every connected satellite):
 *   GET /api/hardware/nodes        — JSON map of per-node snapshots
 *   GET /api/hardware/nodes/stream — SSE, emits the same map every 1 s
 *
 * The legacy local endpoints stay byte-compatible so the mobile app and voice
 * agent (which both consume /api/hardware/stream) keep working unchanged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  collectHardwareSnapshot,
  type HardwareSnapshot,
} from "../federation/hardware-collector.js";
import { getFederationHub } from "../federation/hub.js";
import { loadConfig } from "../config/config.js";
import os from "node:os";

// Re-export so existing consumers (UI, mobile) keep working.
export type { HardwareSnapshot };

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function writeSse(res: ServerResponse, data: unknown) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client disconnected
  }
}

function startSseStream(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    res.flushHeaders();
  } catch {
    /* ignore */
  }
}

// ─── Federation node payload ──────────────────────────────────────────────────

export interface NodeHardwareEntry {
  nodeId: string;
  nodeName: string;
  role: "master" | "satellite" | "standalone";
  isLocal: boolean;
  online: boolean;
  /** "online" | "stale" (>5s since last update) | "offline" (>30s) */
  health: "online" | "stale" | "offline";
  lastSeen: number;
  /** Milliseconds since last snapshot push (0 for local master) */
  ageMs: number;
  snapshot: HardwareSnapshot | null;
}

const STALE_MS = 5_000;
const OFFLINE_MS = 30_000;

function classify(ageMs: number): NodeHardwareEntry["health"] {
  if (ageMs <= STALE_MS) return "online";
  if (ageMs <= OFFLINE_MS) return "stale";
  return "offline";
}

async function buildNodeMap(): Promise<{
  role: "master" | "standalone";
  nodes: NodeHardwareEntry[];
}> {
  const hub = getFederationHub();
  const cfg = loadConfig();
  const localName = cfg.federation?.nodeName ?? os.hostname();
  const localId = cfg.federation?.nodeId ?? "local";

  // Always include local node — collect fresh snapshot each call.
  const localSnap = await collectHardwareSnapshot();
  const localEntry: NodeHardwareEntry = {
    nodeId: localId,
    nodeName: localName,
    role: hub ? "master" : "standalone",
    isLocal: true,
    online: true,
    health: "online",
    lastSeen: Date.now(),
    ageMs: 0,
    snapshot: localSnap,
  };

  if (!hub) {
    return { role: "standalone", nodes: [localEntry] };
  }

  const now = Date.now();
  const satellites = hub.getConnectedNodes().map((n) => {
    const cached = hub.getSatelliteHardware(n.id);
    const lastSeen = cached?.receivedAt ?? n.lastHeartbeat ?? n.connectedAt;
    const ageMs = Math.max(0, now - lastSeen);
    const health = cached ? classify(ageMs) : "stale";
    return {
      nodeId: n.id,
      nodeName: n.manifest?.name ?? n.id,
      role: "satellite" as const,
      isLocal: false,
      online: n.state === "registered",
      health,
      lastSeen,
      ageMs,
      snapshot: cached?.snapshot ?? null,
    };
  });

  return { role: "master", nodes: [localEntry, ...satellites] };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function handleHardwareHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname === "/api/hardware/snapshot") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    try {
      const snap = await collectHardwareSnapshot();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(JSON.stringify(snap));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  if (pathname === "/api/hardware/stream") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    startSseStream(res);
    let active = true;
    req.on("close", () => {
      active = false;
    });
    const tick = async () => {
      if (!active) return;
      try {
        const snap = await collectHardwareSnapshot();
        if (active) writeSse(res, snap);
      } catch {
        /* skip failed tick */
      }
      if (active) setTimeout(tick, 1000);
    };
    void tick();
    return true;
  }

  if (pathname === "/api/hardware/nodes") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    try {
      const map = await buildNodeMap();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(JSON.stringify(map));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  if (pathname === "/api/hardware/nodes/stream") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    startSseStream(res);
    let active = true;
    req.on("close", () => {
      active = false;
    });
    const tick = async () => {
      if (!active) return;
      try {
        const map = await buildNodeMap();
        if (active) writeSse(res, map);
      } catch {
        /* skip failed tick */
      }
      if (active) setTimeout(tick, 1000);
    };
    void tick();
    return true;
  }

  return false;
}

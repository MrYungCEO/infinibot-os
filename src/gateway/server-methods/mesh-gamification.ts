/**
 * Mesh Gamification Gateway Methods
 *
 * Server-authoritative XP / levels / quests / leaderboards for the Agent Neural
 * Mesh. All progression is computed in {@link GamificationEngine}; the client
 * only ever *reads* state and (for unlock FX) is told what already happened.
 *
 *   mesh.gamification.state        — progression + quests + recent unlocks for an owner
 *   mesh.gamification.quests       — current-period quests for an owner
 *   mesh.gamification.unlock       — record a real event (task/tool/handshake) → XP
 *   mesh.gamification.leaderboard  — top owners by XP; scope "federation" hub-spoke aggregates
 *
 * Federation: the master fans out a scope:"local" leaderboard query to every
 * connected satellite and merges; satellites tunnel scope:"federation" up to
 * master via forwardGatewayCall (memory: isLocalNodeId + forwardGatewayCall are
 * the two choke points; sat→sat is hub-and-spoke through master).
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFederationHub } from "../../federation/hub.js";
import { forwardGatewayCallToNode } from "../../federation/hub-forward.js";
import { getFederationSatellite } from "../../federation/satellite.js";
import { getGamificationEngine, type Progression } from "../../achievements/gamification.js";
import { getAchievementDef } from "../../achievements/kinds.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway").child("mesh-gamification");

function localNodeInfo(): { nodeId: string; nodeName: string } {
  const hub = getFederationHub();
  if (hub) {
    const nodeId = hub.getEventBus().getNodeId();
    return { nodeId, nodeName: nodeId };
  }
  return { nodeId: "local", nodeName: "Local" };
}

interface LeaderEntry extends Progression {
  nodeId: string;
  nodeName: string;
}

export const meshGamificationHandlers: GatewayRequestHandlers = {
  /** Full progression snapshot for one owner (defaults to the global user bucket). */
  "mesh.gamification.state": async ({ params, respond }) => {
    const p = (params ?? {}) as { ownerId?: string };
    const ownerId = typeof p.ownerId === "string" && p.ownerId.trim() ? p.ownerId.trim() : "global";
    const engine = getGamificationEngine();
    const progression = engine.getProgression(ownerId);
    const quests = engine.getQuests(ownerId);
    const unlocks = engine.recentUnlocks(10).map((r) => {
      const def = getAchievementDef(r.kind);
      return { ...r, def };
    });
    respond(true, { ownerId, progression, quests, recentUnlocks: unlocks });
  },

  /** Current-period quests for an owner. */
  "mesh.gamification.quests": async ({ params, respond }) => {
    const p = (params ?? {}) as { ownerId?: string };
    const ownerId = typeof p.ownerId === "string" && p.ownerId.trim() ? p.ownerId.trim() : "global";
    respond(true, { ownerId, quests: getGamificationEngine().getQuests(ownerId) });
  },

  /**
   * Record a real, server-observed event that grants XP. The client never sends
   * an XP amount — it names the event; the engine owns the reward table.
   */
  "mesh.gamification.unlock": async ({ params, respond }) => {
    const p = (params ?? {}) as {
      ownerId?: string;
      event?: "task" | "tool" | "handshake";
      toolName?: string;
      failed?: boolean;
      nodeCount?: number;
    };
    const ownerId = typeof p.ownerId === "string" && p.ownerId.trim() ? p.ownerId.trim() : "";
    if (!ownerId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "ownerId is required"));
      return;
    }
    const engine = getGamificationEngine();
    switch (p.event) {
      case "task":
        engine.recordTaskCompletion(ownerId, { failed: !!p.failed });
        break;
      case "tool":
        engine.recordToolUse(ownerId, typeof p.toolName === "string" ? p.toolName : "tool");
        break;
      case "handshake":
        engine.recordFederationHandshake(
          ownerId,
          typeof p.nodeCount === "number" ? p.nodeCount : 2,
        );
        break;
      default:
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown event"));
        return;
    }
    respond(true, {
      ownerId,
      progression: engine.getProgression(ownerId),
      quests: engine.getQuests(ownerId),
    });
  },

  /**
   * Leaderboard. scope "local" returns this node's owners; scope "federation"
   * (default) aggregates across the mesh via hub-and-spoke.
   */
  "mesh.gamification.leaderboard": async ({ params, respond }) => {
    const p = (params ?? {}) as { scope?: "local" | "federation"; limit?: number };
    const scope = p.scope === "local" ? "local" : "federation";
    const limit = typeof p.limit === "number" ? Math.max(1, Math.min(100, p.limit)) : 20;
    const engine = getGamificationEngine();
    const { nodeId, nodeName } = localNodeInfo();

    const localEntries: LeaderEntry[] = engine
      .getLeaderboard(limit)
      .map((prog) => ({ ...prog, nodeId, nodeName }));

    if (scope === "local") {
      respond(true, { scope: "local", nodeId, entries: localEntries });
      return;
    }

    // Federation scope.
    const hub = getFederationHub();
    if (hub) {
      // Master: merge local + each connected satellite's local board.
      const merged: LeaderEntry[] = [...localEntries];
      const nodes = hub.getConnectedNodes?.() ?? [];
      await Promise.all(
        nodes.map(async (n) => {
          try {
            const res = await forwardGatewayCallToNode<{ entries?: LeaderEntry[] }>(
              n.id,
              "mesh.gamification.leaderboard",
              { scope: "local", limit },
              8000,
            );
            if (res.success && Array.isArray(res.payload?.entries)) {
              const name = n.manifest?.name || n.id;
              for (const e of res.payload!.entries!)
                merged.push({ ...e, nodeId: n.id, nodeName: name });
            }
          } catch (err) {
            log.warn("leaderboard fanout failed", { node: n.id, err: String(err) });
          }
        }),
      );
      merged.sort((a, b) => b.xp - a.xp);
      respond(true, { scope: "federation", nodeId, entries: merged.slice(0, limit) });
      return;
    }

    // Satellite: tunnel the federation query up to master.
    const sat = getFederationSatellite();
    if (sat && sat.getState?.() === "connected") {
      try {
        const res = await sat.invokeOnMaster("mesh.gamification.leaderboard", {
          scope: "federation",
          limit,
        });
        if (res.success) {
          respond(true, res.data);
          return;
        }
      } catch (err) {
        log.warn("leaderboard master tunnel failed", { err: String(err) });
      }
    }
    // Not federated (or master unreachable) — local board is the federation.
    respond(true, { scope: "federation", nodeId, entries: localEntries });
  },
};

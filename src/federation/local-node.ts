/**
 * Local-node identity helpers for federation routing.
 *
 * A spawn/RPC handler that accepts a `nodeId` needs one decision: does this
 * id refer to "this process" (run locally) or to a peer (forward it)? Getting
 * that wrong in either direction is the classic federation bug — a forwarded
 * call that lands on the target must run locally instead of bouncing again
 * (infinite re-forward), and a sat→self call should never round-trip through
 * master.
 *
 * `isLocalNodeId` is the single source of truth for that decision and is used
 * by both the gateway handlers (sessions.spawn / terminal.spawnAgent) and the
 * cross-node forwarder.
 */

import { getFederationHub } from "./hub.js";
import { getFederationSatellite } from "./satellite.js";

/**
 * The id of the node this process represents, or null if this process is not
 * part of a federation (standalone install).
 */
export function getLocalNodeId(): string | null {
  const hub = getFederationHub();
  if (hub && typeof (hub as { getLocalNodeId?: () => string }).getLocalNodeId === "function") {
    return (hub as unknown as { getLocalNodeId: () => string }).getLocalNodeId();
  }
  const sat = getFederationSatellite();
  if (sat) {
    try {
      return sat.getManifest().id;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True when `nodeId` refers to "this process" and a spawn/RPC should run
 * locally instead of being forwarded.
 *
 * Local means: empty, the literal "local", or the current node's own id.
 * On a master, the alias "master" is ALSO local (the master answers to it).
 * On a satellite, "master" is NOT local — it must route up to the hub.
 */
export function isLocalNodeId(nodeId: string | null | undefined): boolean {
  const id = (nodeId ?? "").trim();
  if (id === "" || id === "local") return true;
  const hub = getFederationHub();
  const localId = getLocalNodeId();
  if (hub) {
    // The master answers to its own id and the "master" alias.
    if (id === "master") return true;
    return localId !== null && id === localId;
  }
  // On a satellite (or standalone), only the own id is local.
  return localId !== null && id === localId;
}

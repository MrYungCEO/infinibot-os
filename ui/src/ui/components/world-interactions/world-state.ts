/**
 * world-state.ts — pure readers, hit-testing, and the RPC bridge for
 * <world-interactions>. No DOM, no Lit; trivially unit-testable.
 */
import type { FxAgent, GatewayClientLike, WorldSector } from "./types.js";

/** Live agent feed from the world viz (empty array when unpublished). */
export function readAgents(): FxAgent[] {
  // __agentFxState is published by <agent-fx-layer> with a narrower type; read
  // structurally and trust the richer optional fields when the viz supplies them.
  const s = (window as unknown as { __agentFxState?: FxAgent[] }).__agentFxState;
  return Array.isArray(s) ? s : [];
}

/** Live sector/building feed (empty when the viz doesn't publish drop zones). */
export function readSectors(): WorldSector[] {
  const s = window.__worldSectors;
  return Array.isArray(s) ? s : [];
}

/** The shared gateway WS client, or null before the socket says hello. */
export function gatewayClient(): GatewayClientLike | null {
  const c = window.__infinibotGatewayClient;
  return c && typeof c.request === "function" ? c : null;
}

export interface RpcOutcome<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/**
 * Fire a gateway RPC, never throwing. Returns a discriminated outcome so the
 * UI can toast success/failure without try/catch sprawl at the call sites.
 */
export async function callRpc<T = unknown>(
  method: string,
  params?: unknown,
): Promise<RpcOutcome<T>> {
  const client = gatewayClient();
  if (!client) return { ok: false, error: "gateway offline" };
  try {
    const result = await client.request<T>(method, params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Best display name for an agent. */
export function agentLabel(a: FxAgent): string {
  return (a.label && a.label.trim()) || a.id || "agent";
}

/** Stable RPC selector for an agent — prefers runId, then sessionKey, then id. */
export function agentRpcTarget(a: FxAgent): {
  runId?: string;
  sessionKey?: string;
} {
  return {
    runId: a.runId || undefined,
    sessionKey: a.sessionKey || a.id || undefined,
  };
}

const AGENT_HIT_RADIUS = 20;

/** Nearest agent within the hit radius of (px, py), or null. */
export function hitTestAgent(
  agents: readonly FxAgent[],
  px: number,
  py: number,
  radius = AGENT_HIT_RADIUS,
): FxAgent | null {
  let best: FxAgent | null = null;
  let bestD = radius * radius;
  for (const a of agents) {
    const dx = a.x - px;
    const dy = a.y - py;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/** Sector whose rect/circle contains (px, py), or null. */
export function hitTestSector(
  sectors: readonly WorldSector[],
  px: number,
  py: number,
): WorldSector | null {
  for (const s of sectors) {
    const hw = s.w ?? 44;
    const hh = s.h ?? 44;
    if (px >= s.x - hw && px <= s.x + hw && py >= s.y - hh && py <= s.y + hh) {
      return s;
    }
  }
  return null;
}

/** All agents whose centers fall inside the given rect (any winding). */
export function agentsInRect(
  agents: readonly FxAgent[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): FxAgent[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  return agents.filter(
    (a) => a.x >= left && a.x <= right && a.y >= top && a.y <= bottom,
  );
}

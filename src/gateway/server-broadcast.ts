import type { GatewayWsClient } from "./server/ws-types.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";
import { getScopedUserId } from "../config/paths.js";
import { userMayReceiveEvent } from "../access/events.js";

const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "approval.requested": [APPROVALS_SCOPE],
  "approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
};

function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  if (!required) return true;
  const role = client.connect.role ?? "operator";
  if (role !== "operator") return false;
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) return true;
  return required.some((scope) => scopes.includes(scope));
}

export type GatewayBroadcaster = ReturnType<typeof createGatewayBroadcaster>;

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;
  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
      /** Deliver only to these connections (e.g. live browser frames). */
      connIds?: ReadonlySet<string>;
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq,
      clients: params.clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    logWs("out", "event", logMeta);
    // SaaS tenant isolation: when this event is emitted inside a tenant's
    // request scope (runWithUserId), deliver it only to that tenant's clients.
    // Events emitted outside any request scope (health/presence timers, boot)
    // have no scoped namespace and fan out to everyone as before. In local mode
    // no client has a saasNamespace so this filter is inert.
    const scopedNs = getScopedUserId();
    for (const c of params.clients) {
      if (opts?.connIds && !opts.connIds.has(c.connId)) continue;
      if (scopedNs && c.saasNamespace !== scopedNs) continue;
      if (!hasEventScope(c, event)) continue;
      if (c.access && !userMayReceiveEvent(c.access, event, payload)) continue;
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) continue;
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };
  return { broadcast };
}

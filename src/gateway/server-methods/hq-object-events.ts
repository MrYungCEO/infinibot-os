/**
 * Live updates for the Business HQ object stores (decisions, risks,
 * commitments, opportunities). Their writes are synchronous SQLite, but no
 * event announced them, so a change made in another tab / device or by an
 * agent never showed on an open Dashboard until it re-listed by itself.
 *
 * `withHqObjectBroadcast` wraps a handler map: every successful mutating call
 * broadcasts `hq.object.changed` { kind, op, id } and the Dashboard re-lists
 * the object stores.
 */
import type { GatewayRequestHandlers } from "./types.js";

export type HqObjectKind = "decision" | "risk" | "commitment" | "opportunity";

export function withHqObjectBroadcast(
  kind: HqObjectKind,
  handlers: GatewayRequestHandlers,
  mutating: string[],
): GatewayRequestHandlers {
  const out: GatewayRequestHandlers = { ...handlers };
  for (const method of mutating) {
    const inner = handlers[method];
    if (!inner) continue;
    const op = method.slice(method.lastIndexOf(".") + 1);
    out[method] = (opts) =>
      inner({
        ...opts,
        respond: (ok, payload, error, meta) => {
          opts.respond(ok, payload, error, meta);
          if (!ok) return;
          try {
            const p = (opts.params ?? {}) as Record<string, unknown>;
            const res = (payload ?? {}) as Record<string, unknown>;
            const id = (res.id ?? p.id ?? p.decisionId ?? p.opportunityId ?? null) as string | null;
            opts.context?.broadcast?.("hq.object.changed", { kind, op, id }, { dropIfSlow: true });
          } catch {
            /* best-effort live update */
          }
        },
      });
  }
  return out;
}

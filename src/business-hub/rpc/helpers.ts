/**
 * Business hub RPC helpers — every `hub.*` handler is a plain function of its
 * params that returns (or resolves to) the payload; thrown errors become
 * INVALID_REQUEST responses with the error message.
 */

import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../../gateway/server-methods/types.js";
import { getHubDb, type HubDb } from "../db.js";

export type HubCtx = {
  db: HubDb;
  /** Broadcast an event to connected UIs (no-op when unavailable). */
  broadcast: (event: string, payload: unknown) => void;
};

export class HubError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "UNAVAILABLE" = "INVALID_REQUEST",
  ) {
    super(message);
  }
}

type Fn = (params: Record<string, unknown>, ctx: HubCtx) => unknown;

export function hubHandler(fn: Fn): GatewayRequestHandler {
  return async (opts) => {
    const params = (opts.params ?? {}) as Record<string, unknown>;
    const context = (
      opts as { context?: { broadcast?: (e: string, p: unknown, o?: unknown) => void } }
    ).context;
    const ctx: HubCtx = {
      db: getHubDb(),
      broadcast: (event, payload) => {
        try {
          context?.broadcast?.(event, payload, { dropIfSlow: true });
        } catch {
          /* best effort */
        }
      },
    };
    try {
      const result = await fn(params, ctx);
      opts.respond(true, result ?? { ok: true });
    } catch (err) {
      const code = err instanceof HubError ? err.code : "INVALID_REQUEST";
      opts.respond(false, undefined, {
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function defineHubHandlers(map: Record<string, Fn>): GatewayRequestHandlers {
  const out: GatewayRequestHandlers = {};
  for (const [k, fn] of Object.entries(map)) out[k] = hubHandler(fn);
  return out;
}

export function reqStr(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v.trim()) throw new HubError(`${key} required`);
  return v.trim();
}

export function optStr(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function optNum(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function optBool(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key];
  return typeof v === "boolean" ? v : undefined;
}

export function strArr(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key];
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
}

/**
 * Local model runtime RPCs (GPU widget in the model picker / System page):
 * status, manual Start/Stop, swap log. Start returns at once and streams
 * progress as `localRuntimes.status` events unless `wait: true`.
 */

import { getLocalRuntimeManager } from "../../local-runtimes/runtime.js";
import { LocalRuntimeError } from "../../local-runtimes/manager.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Respond = GatewayRequestHandlerOptions["respond"];

function fail(respond: Respond, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, {
    code: err instanceof LocalRuntimeError ? "UNAVAILABLE" : "INTERNAL_ERROR",
    message,
  });
}

function runtimeId(opts: GatewayRequestHandlerOptions): string {
  const p = (opts.params ?? {}) as Record<string, unknown>;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (!id) throw new Error("id is required");
  if (!getLocalRuntimeManager().spec(id)) {
    // Only registry runtimes are ever started/stopped.
    throw new LocalRuntimeError(`"${id}" is not in the local runtime registry`, { runtimeId: id });
  }
  return id;
}

function wantsWait(opts: GatewayRequestHandlerOptions): boolean {
  return ((opts.params ?? {}) as Record<string, unknown>).wait === true;
}

export const localRuntimesHandlers: GatewayRequestHandlers = {
  "localRuntimes.status": async (opts) => {
    try {
      opts.respond(true, await getLocalRuntimeManager().status());
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "localRuntimes.log": async (opts) => {
    try {
      opts.respond(true, { entries: getLocalRuntimeManager().recentLog().reverse() });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "localRuntimes.start": async (opts) => {
    try {
      const id = runtimeId(opts);
      const m = getLocalRuntimeManager();
      const job = m.start(id);
      if (wantsWait(opts)) {
        await job;
        opts.respond(true, { ok: true, status: await m.status() });
        return;
      }
      job.catch(() => undefined); // failure is reported via status/log + events
      opts.respond(true, { ok: true, started: true, swap: m.currentSwap() });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "localRuntimes.stop": async (opts) => {
    try {
      const id = runtimeId(opts);
      const m = getLocalRuntimeManager();
      const job = m.stop(id, "manual");
      if (wantsWait(opts)) {
        await job;
        opts.respond(true, { ok: true, status: await m.status() });
        return;
      }
      job.catch(() => undefined);
      opts.respond(true, { ok: true, stopping: true });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
};

export const LOCAL_RUNTIMES_READ_METHODS = ["localRuntimes.status", "localRuntimes.log"] as const;
export const LOCAL_RUNTIMES_WRITE_METHODS = ["localRuntimes.start", "localRuntimes.stop"] as const;

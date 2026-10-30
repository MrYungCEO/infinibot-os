/**
 * Federation Files Gateway Handlers
 *
 * Wraps the local `files.*` RPC surface so the UI can read any peer's
 * file system through a single namespace. When `peerId` resolves to this
 * node, the call short-circuits to the local handler. Otherwise it tunnels
 * through `gateway.proxy.invoke` over the federation hub.
 *
 * This file does NOT change `files.*` semantics — wrap, don't retrofit.
 */
import os from "node:os";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import type { ErrorShape } from "../protocol/index.js";
import { filesHandlers } from "./files.js";
import { loadConfig } from "../../config/io.js";
import { getFederationHub } from "../../federation/index.js";

interface HubInvokeOnNode {
  invokeOnNode: (
    nodeId: string,
    command: string,
    params: unknown,
    timeoutMs?: number,
  ) => Promise<{ success: boolean; reply?: string; error?: string }>;
  getNode?: (id: string) => { state: string } | undefined;
}

function localNodeId(): string {
  try {
    const cfg = loadConfig();
    return cfg.federation?.nodeId ?? os.hostname();
  } catch {
    return os.hostname();
  }
}

function isLocalPeer(peerId: string): boolean {
  if (!peerId) return false;
  if (peerId === "local") return true;
  return peerId === localNodeId();
}

/** Run a local files.* handler and capture its respond() into a result. */
function invokeLocalHandler(
  opts: GatewayRequestHandlerOptions,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: ErrorShape }> {
  const handler = filesHandlers[method];
  if (!handler) {
    return Promise.resolve({
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: `No local handler for ${method}` },
    });
  }
  return new Promise((resolve) => {
    const respond: RespondFn = (ok, payload, error) => {
      resolve({ ok, payload, error });
    };
    try {
      const ret = handler({ ...opts, params, respond });
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        (ret as Promise<unknown>).catch((err: unknown) => {
          resolve({
            ok: false,
            error: {
              code: "LOCAL_INVOKE_ERROR",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      }
    } catch (err) {
      resolve({
        ok: false,
        error: {
          code: "LOCAL_INVOKE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}

/** Forward a files.* call to a remote peer via gateway.proxy.invoke. */
async function invokeRemoteHandler(
  peerId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }> {
  const hub = getFederationHub();
  if (!hub) {
    return {
      ok: false,
      error: { code: "NOT_MASTER", message: "Federation hub not available on this node" },
    };
  }
  const node = hub.getNode?.(peerId);
  if (!node || node.state !== "registered") {
    return {
      ok: false,
      error: { code: "NOT_CONNECTED", message: `Node ${peerId} not connected` },
    };
  }
  try {
    const hubAny = hub as unknown as HubInvokeOnNode;
    const proxyRes = await hubAny.invokeOnNode(
      peerId,
      "gateway.proxy.invoke",
      { method, params },
      30_000,
    );
    if (!proxyRes.success) {
      return {
        ok: false,
        error: {
          code: "REMOTE_INVOKE_FAILED",
          message: proxyRes.error ?? "remote invoke failed",
        },
      };
    }
    let parsed: unknown = null;
    if (typeof proxyRes.reply === "string") {
      try {
        parsed = JSON.parse(proxyRes.reply);
      } catch {
        parsed = proxyRes.reply;
      }
    }
    return { ok: true, payload: parsed };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "REMOTE_INVOKE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Builds a federation.files.* handler that wraps a single local files.*
 * method. `errOp` becomes the suffix of FEDERATION_FILES_<errOp>_ERROR
 * when the underlying invoke fails (local or remote).
 */
function buildHandler(
  localMethod: string,
  errOp: string,
  mapParams: (p: Record<string, unknown>) => Record<string, unknown>,
) {
  return async (opts: GatewayRequestHandlerOptions) => {
    const peerId = typeof opts.params.peerId === "string" ? opts.params.peerId : "";
    if (!peerId) {
      opts.respond(false, undefined, {
        code: "MISSING_PEER_ID",
        message: "peerId is required",
      });
      return;
    }
    const innerParams = mapParams(opts.params);
    const errorCode = `FEDERATION_FILES_${errOp}_ERROR`;
    if (isLocalPeer(peerId)) {
      const res = await invokeLocalHandler(opts, localMethod, innerParams);
      if (res.ok) {
        opts.respond(true, res.payload);
      } else {
        opts.respond(false, undefined, {
          code: errorCode,
          message: res.error?.message ?? "local invoke failed",
        });
      }
      return;
    }
    const res = await invokeRemoteHandler(peerId, localMethod, innerParams);
    if (res.ok) {
      opts.respond(true, res.payload);
    } else {
      opts.respond(false, undefined, {
        code: errorCode,
        message: res.error?.message ?? "remote invoke failed",
      });
    }
  };
}

export const federationFilesHandlers: GatewayRequestHandlers = {
  "federation.files.list": buildHandler("files.list", "LIST", (p) => ({
    path: p.path,
  })),

  "federation.files.tree": buildHandler("files.tree", "TREE", (p) => ({
    path: p.path,
    depth: p.depth,
  })),

  "federation.files.stat": buildHandler("files.stat", "STAT", (p) => ({
    path: p.path,
  })),

  "federation.files.read": buildHandler("files.read", "READ", (p) => ({
    path: p.path,
  })),

  // `files.search` reads its root from `params.path`; expose it as `root`
  // on the federation surface to match the task contract.
  "federation.files.search": buildHandler("files.search", "SEARCH", (p) => ({
    query: p.query,
    path: p.root,
  })),

  "federation.files.roots.list": buildHandler("files.roots.list", "ROOTS_LIST", () => ({})),
};

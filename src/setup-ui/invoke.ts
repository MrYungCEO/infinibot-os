/**
 * Call a gateway request handler outside the gateway: the standalone setup
 * server has no request plumbing, and the handlers it reuses only read
 * `params` and call `respond`.
 */
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";

export type RpcResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export function invokeHandler(
  handler: GatewayRequestHandler,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  return new Promise<RpcResult>((resolve) => {
    let settled = false;
    const respond = (ok: boolean, data?: unknown, error?: { code: string; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(
        ok
          ? { ok: true, data }
          : { ok: false, error: error ?? { code: "UNKNOWN", message: "RPC failed" } },
      );
    };
    Promise.resolve(
      handler({
        // None of the reused handlers read these: minimal stubs keep the
        // gateway runtime out of the setup CLI.
        req: {} as never,
        params: params ?? {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as never,
      }),
    ).catch((err: unknown) => {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/** Unwrap a handler result, throwing its error message. */
export async function invokeOrThrow<T>(
  handler: GatewayRequestHandler,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await invokeHandler(handler, params);
  if (!res.ok) throw new Error(res.error.message);
  return res.data as T;
}

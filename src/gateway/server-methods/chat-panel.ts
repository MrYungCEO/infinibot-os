/**
 * chat.panel.* — gateway RPCs behind agent-invokable chat panels
 * (see src/chat-panels/resolve.ts and the `show_panel` agent tool).
 * Generalised from the OmniTrade fork's omnitrade-panel.ts.
 *
 *   chat.panel.show     — resolve + broadcast `chat.panel.show` (called by the
 *                         show_panel tool; the broadcast lets a display:"modal"
 *                         panel pop on every connected UI).
 *   chat.panel.resolve  — resolve once (initial render; includes text fallback).
 *   chat.panel.refresh  — live re-query from an open card/modal.
 *   chat.panel.kinds    — the kind catalogue (id/title/refreshMs).
 *
 * All read-only. Data comes from the REAL sibling handlers dispatched
 * in-process (reusing this request's client/context, so tenant scoping and
 * federation proxies behave exactly as if the UI had called them), limited to
 * the allowlist declared by the panel kinds (PANEL_METHODS).
 *
 * Registered in server-methods.ts: spread into coreGatewayHandlers AND listed
 * in READ_METHODS — an unregistered method is a silent "unknown method".
 */

import { randomUUID } from "node:crypto";

import {
  PANEL_METHODS,
  allPanelKindDefs,
  buildPanelRef,
  getPanelKind,
  isPanelKind,
  isPluginPanelKind,
  resolvePanel,
  sanitizeQuery,
  type PanelCaller,
  type PanelDisplay,
} from "../../chat-panels/resolve.js";
import { getPluginGatewayHandlers } from "../../plugins/runtime.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

export const CHAT_PANEL_SHOW_EVENT = "chat.panel.show";

let handlerMap: Promise<GatewayRequestHandlers> | null = null;
/** Lazy: server-methods.ts imports this module, so resolve the map at call time. */
function coreHandlers(): Promise<GatewayRequestHandlers> {
  handlerMap ??= import("../server-methods.js").then((m) => m.coreGatewayHandlers);
  // Core kinds may read data a first-party plugin now serves under its legacy
  // name (opportunity.list, decision.list, clients.list → business-agency).
  // Plugin handlers are looked up per call so a disabled plugin's are gone.
  return handlerMap.then((core) => ({
    ...getPluginGatewayHandlers(),
    ...core,
  }));
}

/**
 * Plugin panel kinds call their own plugin's handlers. Their method list was
 * checked at registration (declared, read-scoped RPCs of that plugin), and
 * resolvePanel's guarded caller limits each kind to exactly that list.
 */
async function pluginHandlers(): Promise<GatewayRequestHandlers> {
  return getPluginGatewayHandlers();
}

/** Dispatch an allowlisted sibling handler in-process. */
export function localPanelCaller(
  opts: GatewayRequestHandlerOptions,
  resolveHandlers: () => Promise<GatewayRequestHandlers> = coreHandlers,
  allowedMethods: ReadonlySet<string> = PANEL_METHODS,
): PanelCaller {
  return async (method, params) => {
    if (!allowedMethods.has(method)) throw new Error(`panel: ${method} is not a panel data source`);
    const handler = (await resolveHandlers())[method] as GatewayRequestHandler | undefined;
    if (!handler) throw new Error(`panel: no handler for ${method}`);
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(payload);
        else {
          // Some handlers (plugins) put the reason in the payload instead.
          const fromPayload =
            payload &&
            typeof payload === "object" &&
            typeof (payload as { error?: unknown }).error === "string"
              ? (payload as { error: string }).error
              : undefined;
          reject(new Error(error?.message ?? fromPayload ?? `${method} failed`));
        }
      };
      Promise.resolve(
        handler({
          req: { ...opts.req, method, params },
          params,
          client: opts.client,
          isWebchatConnect: opts.isWebchatConnect,
          respond: respond as GatewayRequestHandlerOptions["respond"],
          context: opts.context,
        }),
      ).catch((err) =>
        respond(false, undefined, {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  };
}

function badKind(respond: GatewayRequestHandlerOptions["respond"]) {
  respond(false, undefined, {
    code: "INVALID_PARAMS",
    message: `kind must be one of ${allPanelKindDefs()
      .map((k) => k.id)
      .join(" | ")}`,
  });
}

/** The in-process caller for a kind: core handlers, or its plugin's handlers. */
function callerFor(kind: string, opts: GatewayRequestHandlerOptions): PanelCaller {
  if (isPluginPanelKind(kind)) {
    return localPanelCaller(opts, pluginHandlers, new Set(getPanelKind(kind)?.methods ?? []));
  }
  return localPanelCaller(opts);
}

const titleOf = (p: Record<string, unknown>) => (typeof p.title === "string" ? p.title : undefined);

export const chatPanelHandlers: GatewayRequestHandlers = {
  "chat.panel.kinds": ({ respond }) => {
    respond(true, {
      kinds: allPanelKindDefs().map((k) => ({
        id: k.id,
        title: k.title,
        description: k.description,
        refreshMs: k.refreshMs,
      })),
    });
  },

  "chat.panel.resolve": async (opts) => {
    const { params, respond } = opts;
    if (!isPanelKind(params.kind)) return badKind(respond);
    respond(
      true,
      await resolvePanel(params.kind, params.query, callerFor(params.kind, opts), {
        title: titleOf(params),
      }),
    );
  },

  "chat.panel.refresh": async (opts) => {
    const { params, respond } = opts;
    if (!isPanelKind(params.kind)) return badKind(respond);
    const r = await resolvePanel(params.kind, params.query, callerFor(params.kind, opts), {
      title: titleOf(params),
    });
    // The card already has its text fallback; skip it on the hot path.
    respond(true, { ...r, text: "" });
  },

  "chat.panel.show": async (opts) => {
    const { params, respond, context } = opts;
    if (!isPanelKind(params.kind)) return badKind(respond);
    const query = sanitizeQuery(params.query);
    const display: PanelDisplay = params.display === "modal" ? "modal" : "inline";
    const result = await resolvePanel(params.kind, query, callerFor(params.kind, opts), {
      title: titleOf(params),
    });
    const panelId =
      typeof params.panelId === "string" && params.panelId.trim()
        ? params.panelId.trim()
        : `panel_${randomUUID()}`;
    const ref = buildPanelRef(result, query, { panelId, display });
    const sourceSession =
      typeof params.sourceSession === "string" ? params.sourceSession : undefined;
    // Best-effort fan-out; a broadcast failure must not fail the tool call.
    try {
      context.broadcast(CHAT_PANEL_SHOW_EVENT, {
        ...ref,
        sourceSession,
        initial: result.data,
      });
    } catch {
      /* no UI connected — the tool result still carries the ref + text */
    }
    respond(true, { ...result, panelId, ref });
  },
};

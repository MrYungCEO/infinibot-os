import type { GatewayRequestHandler, GatewayRequestHandlers } from "infinibot/plugin-sdk";
import type { WhiteboardStore } from "./board-store.js";

function guarded(fn: GatewayRequestHandler): GatewayRequestHandler {
  return async (opts) => {
    try { await fn(opts); }
    catch (error) { opts.respond(false, undefined, { code: "WHITEBOARD_ERROR", message: error instanceof Error ? error.message : String(error) }); }
  };
}

export function createWhiteboardHandlers(store: WhiteboardStore): GatewayRequestHandlers {
  return {
    "whiteboard.boards.list": guarded(async ({ respond }) => respond(true, { boards: await store.list() })),
    "whiteboard.boards.get": guarded(async ({ params, respond }) => respond(true, { data: await store.get(params.id) })),
    "whiteboard.boards.save": guarded(async ({ params, respond }) => respond(true, { board: await store.save(params.id, params.data) })),
    "whiteboard.boards.delete": guarded(async ({ params, respond }) => { await store.remove(params.id); respond(true, { ok: true }); }),
    "whiteboard.boards.rename": guarded(async ({ params, respond }) => { await store.rename(params.id, params.newId); respond(true, { ok: true }); }),
    "whiteboard.templates.list": guarded(async ({ respond }) => respond(true, { templates: await store.list(true) })),
    "whiteboard.templates.get": guarded(async ({ params, respond }) => respond(true, { data: await store.get(params.id, true) })),
    "whiteboard.templates.save": guarded(async ({ params, respond }) => respond(true, { template: await store.save(params.id, params.data, true) })),
    "whiteboard.canvas.update": async ({ params, respond, context }) => {
      if (!Array.isArray(params.elements)) return respond(false, undefined, { code: "BAD_REQUEST", message: "elements must be an array" });
      context.broadcast("canvas.update", { elements: params.elements }, { dropIfSlow: true });
      respond(true, { ok: true, count: params.elements.length });
    },
    "whiteboard.canvas.view": async ({ params, respond, context }) => { context.broadcast("canvas.view", params, { dropIfSlow: true }); respond(true, { ok: true }); },
    "whiteboard.canvas.clear": async ({ respond, context }) => { context.broadcast("canvas.clear", {}, { dropIfSlow: true }); respond(true, { ok: true }); },
  };
}

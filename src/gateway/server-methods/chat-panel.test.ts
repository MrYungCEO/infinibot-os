import { describe, expect, it, vi } from "vitest";

import { chatPanelHandlers, localPanelCaller } from "./chat-panel.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

function opts(params: Record<string, unknown>, broadcast = vi.fn()) {
  const respond = vi.fn();
  return {
    o: {
      req: { type: "req", id: "1", method: "x", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { broadcast },
    } as unknown as GatewayRequestHandlerOptions,
    respond,
    broadcast,
  };
}

describe("localPanelCaller", () => {
  const handlers: GatewayRequestHandlers = {
    "kanban.projects.list": ({ respond }) => respond(true, [{ id: "p1" }]),
    "kanban.tasks.list": ({ respond }) =>
      respond(false, undefined, { code: "X", message: "store down" }),
    "kanban.tasks.update": ({ respond }) => respond(true, { hacked: true }),
  };
  const call = localPanelCaller(opts({}).o, async () => handlers);

  it("dispatches allowlisted read handlers in-process", async () => {
    await expect(call("kanban.projects.list", {})).resolves.toEqual([{ id: "p1" }]);
  });
  it("turns an error frame into a rejection with the real message", async () => {
    await expect(call("kanban.tasks.list", {})).rejects.toThrow("store down");
  });
  it("refuses write methods even if a handler exists", async () => {
    await expect(call("kanban.tasks.update", {})).rejects.toThrow(/not a panel data source/);
  });
});

describe("chat.panel.* handlers", () => {
  it("reject unknown kinds with INVALID_PARAMS", async () => {
    const { o, respond } = opts({ kind: "nope" });
    await chatPanelHandlers["chat.panel.resolve"](o);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
  });

  it("show resolves, broadcasts chat.panel.show and returns the ref", async () => {
    const { o, respond, broadcast } = opts({
      kind: "table",
      query: { columns: ["a"], rows: [[1]] },
      display: "modal",
      sourceSession: "agent:main:main",
    });
    await chatPanelHandlers["chat.panel.show"](o);
    expect(broadcast).toHaveBeenCalledWith(
      "chat.panel.show",
      expect.objectContaining({
        kind: "table",
        display: "modal",
        sourceSession: "agent:main:main",
      }),
    );
    const payload = respond.mock.calls[0][1] as {
      ref: { v: number; panelId: string };
      count: number;
    };
    expect(payload.ref.v).toBe(1);
    expect(payload.ref.panelId).toMatch(/^panel_/);
    expect(payload.count).toBe(1);
  });

  it("refresh omits the text fallback", async () => {
    const { o, respond } = opts({ kind: "table", query: { rows: [[1]] } });
    await chatPanelHandlers["chat.panel.refresh"](o);
    expect(respond.mock.calls[0][1]).toMatchObject({ text: "", count: 1 });
  });
});

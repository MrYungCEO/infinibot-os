import { beforeEach, describe, expect, it, vi } from "vitest";

const forwardMock = vi.hoisted(() => vi.fn());
vi.mock("../../federation/hub-forward.js", () => ({ forwardGatewayCall: forwardMock }));

import type { GatewayWsClient } from "../server/ws-types.js";
import {
  clearUiCapabilitiesCache,
  listUiControlAudit,
  UI_CONTROL_PROTOCOL,
} from "../ui-control-federation.js";
import { resetUiGuideStateForTests } from "../ui-guide.js";
import { invokeUIControlAction, setUIControlBroadcaster, uiControlHandlers } from "./ui-control.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Sent = { view: string; action: string; args: Record<string, unknown>; connId?: string };

function setup(): { sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    connId: "conn-local-1",
    socket: {
      send: (raw: string) => {
        const frame = JSON.parse(raw) as { payload: Sent & { requestId: string } };
        sent.push(frame.payload);
        // Answer like a browser would.
        queueMicrotask(() => {
          void uiControlHandlers["ui.response"]!({
            req: {
              type: "req",
              id: "r",
              method: "ui.response",
              params: {
                requestId: frame.payload.requestId,
                ok: true,
                payload: {
                  view: frame.payload.view,
                  action: frame.payload.action,
                  dataUrl: "data:image/jpeg;base64,AAAA",
                },
              },
            },
            params: {},
            respond: () => undefined,
            client: null,
            isWebchatConnect: () => false,
            context: {} as never,
          } as unknown as GatewayRequestHandlerOptions);
        });
      },
    },
    connect: {
      role: "operator",
      client: { id: "infinibot-control-ui", mode: "webchat", version: "t", instanceId: "i1" },
    },
  } as unknown as GatewayWsClient;
  setUIControlBroadcaster({
    clients: new Set([client]),
    broadcaster: { broadcast: () => undefined },
  });
  return { sent };
}

function remote(handlers: Record<string, (p: Record<string, unknown>) => unknown>) {
  forwardMock.mockImplementation(
    async (nodeId: string, method: string, params: Record<string, unknown>) => {
      const h = handlers[method];
      if (!h) return { success: false, error: `unknown method: ${method}` };
      return { success: true, payload: h({ ...params, __node: nodeId }) };
    },
  );
}

beforeEach(() => {
  forwardMock.mockReset();
  clearUiCapabilitiesCache();
  resetUiGuideStateForTests();
});

describe("ui_control node routing", () => {
  it("forwards node + tab to the owning node and tags the result", async () => {
    setup();
    remote({
      "ui_control.capabilities": () => ({ protocol: UI_CONTROL_PROTOCOL, features: [] }),
      "ui_control.invoke": (p) => ({ ok: true, ran: p.action, onNode: p.__node, tab: p.tab }),
    });
    const res = await invokeUIControlAction({
      action: "navigate",
      node: "laptop",
      tab: "Foxtrot",
      route: "/research",
    });
    expect(res).toMatchObject({
      ok: true,
      ran: "navigate",
      onNode: "laptop",
      tab: "Foxtrot",
      node: "laptop",
    });
    expect(forwardMock.mock.calls.map((c) => c[1])).toEqual([
      "ui_control.capabilities",
      "ui_control.invoke",
    ]);
  });

  it("honours the nodeId a satellite re-attaches when tunnelling through the master", async () => {
    // Regression: ui_control used to read only `node`, so sat→sat calls ran
    // on the master's own tabs instead of reaching the sibling.
    setup();
    remote({
      "ui_control.capabilities": () => ({ protocol: UI_CONTROL_PROTOCOL, features: [] }),
      "ui_control.invoke": (p) => ({ ok: true, onNode: p.__node }),
    });
    const res = await invokeUIControlAction({
      action: "dispatch",
      nodeId: "sat-b",
      view: "nav",
      op: "switch_tab",
    });
    expect(res).toMatchObject({ ok: true, onNode: "sat-b" });
  });

  it("accepts the compound 'node/Tab' address", async () => {
    setup();
    remote({
      "ui_control.capabilities": () => ({ protocol: UI_CONTROL_PROTOCOL, features: [] }),
      "ui_control.invoke": (p) => ({ ok: true, onNode: p.__node, tab: p.tab }),
    });
    const res = await invokeUIControlAction({ action: "focus_tab", tab: "laptop/Foxtrot" });
    expect(res).toMatchObject({ onNode: "laptop", tab: "Foxtrot" });
  });

  it("runs locally for node 'local' and never touches the transport", async () => {
    const { sent } = setup();
    const res = await invokeUIControlAction({ action: "screenshot", node: "local" });
    expect(res).toMatchObject({ ok: true, payload: { view: "window", action: "screenshot" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ view: "window", action: "screenshot", connId: "conn-local-1" });
    expect(forwardMock).not.toHaveBeenCalled();
  });

  it("pins a mirror's local source to this node's id before forwarding", async () => {
    setup();
    remote({
      "ui_control.capabilities": () => ({ protocol: UI_CONTROL_PROTOCOL, features: [] }),
      "ui_control.invoke": (p) => ({ ok: true, source: p.source }),
    });
    const res = await invokeUIControlAction({
      action: "mirror",
      node: "laptop",
      tab: "Foxtrot",
      source: { tab: "Alpha" },
    });
    // Standalone test process → local id "local"; a real node sends its own id.
    expect(res.source).toEqual({ node: "local", tab: "Alpha", label: "local · Alpha" });
  });

  it("opens the mirror on the display window with the source as seen from there", async () => {
    const { sent } = setup();
    const res = await invokeUIControlAction({
      action: "mirror",
      source: { node: "master-1", tab: "Alpha" },
      origin: { nodeId: "master-1", hops: 1 },
    });
    expect(res.ok).toBe(true);
    expect(sent[0]).toMatchObject({
      view: "remote_screen",
      action: "open",
      args: { node: "master-1", tab: "Alpha" },
    });
  });

  it("records inbound cross-node actions in this node's audit log", async () => {
    setup();
    await invokeUIControlAction({
      action: "window_state",
      origin: { nodeId: "laptop", sessionKey: "agent:main:x", hops: 1 },
    });
    expect(listUiControlAudit({ node: "laptop", limit: 1 })[0]).toMatchObject({
      direction: "inbound",
      fromNode: "laptop",
      action: "window_state",
      sessionKey: "agent:main:x",
      ok: true,
    });
  });

  it("returns NODE_UPDATE_REQUIRED for an old node instead of a silent failure", async () => {
    setup();
    remote({ "ui_control.invoke": () => ({ ok: true }) });
    const res = await invokeUIControlAction({
      action: "screenshot",
      node: "old-laptop",
      tab: "Foxtrot",
    });
    expect(res).toMatchObject({
      ok: false,
      code: "NODE_UPDATE_REQUIRED",
      update: { method: "federation.node.update" },
    });
  });

  it("serves ui_control.capabilities locally and for a peer", async () => {
    setup();
    remote({ "ui_control.capabilities": () => ({ protocol: 2, features: ["x"], nodeId: "peer" }) });
    const call = async (params: Record<string, unknown>) => {
      let out: unknown;
      await uiControlHandlers["ui_control.capabilities"]!({
        params,
        respond: (_ok: boolean, p?: unknown) => {
          out = p;
        },
      } as unknown as GatewayRequestHandlerOptions);
      return out as Record<string, unknown>;
    };
    expect(await call({})).toMatchObject({
      protocol: UI_CONTROL_PROTOCOL,
      features: expect.arrayContaining(["screenshot", "mirror"]),
    });
    expect(await call({ node: "peer" })).toMatchObject({ nodeId: "peer" });
  });
});

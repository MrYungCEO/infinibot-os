import { beforeEach, describe, expect, it } from "vitest";

import type { GatewayWsClient } from "../server/ws-types.js";
import { bindUiSession, noteUiClientActivity, resetUiGuideStateForTests } from "../ui-guide.js";
import {
  invokeUIControlAction,
  listConnectedUIClients,
  notifyUIClientConnected,
  notifyUIClientDisconnected,
  setTabLabel,
  setUIControlBroadcaster,
  uiControlHandlers,
} from "./ui-control.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

beforeEach(() => resetUiGuideStateForTests());

function makeUiClient(connId: string, instanceId: string): GatewayWsClient {
  return {
    connId,
    socket: {} as GatewayWsClient["socket"],
    connect: {
      role: "operator",
      client: {
        id: "infinibot-control-ui",
        mode: "webchat",
        version: "test",
        instanceId,
      },
    },
  } as GatewayWsClient;
}

function setupClients(clients: Set<GatewayWsClient>): void {
  setUIControlBroadcaster({
    clients,
    broadcaster: {
      broadcast: () => undefined,
    },
  });
}

describe("ui-control tabs", () => {
  it("updates tab labels and clears overrides on disconnect", () => {
    const client = makeUiClient("conn-label-test", "instance-label-test");
    const clients = new Set<GatewayWsClient>([client]);
    setupClients(clients);

    setTabLabel(client.connId, "Ops");

    expect(listConnectedUIClients()).toContainEqual(
      expect.objectContaining({ connId: client.connId, label: "Ops" }),
    );

    clients.delete(client);
    notifyUIClientDisconnected(client);
    clients.add(client);
    notifyUIClientConnected(client);

    expect(listConnectedUIClients()).toContainEqual(
      expect.objectContaining({
        connId: client.connId,
        label: expect.not.stringMatching(/^Ops$/),
      }),
    );
  });

  it("rejects empty tab labels in ui.set_tab_label", async () => {
    const client = makeUiClient("conn-empty-label-test", "instance-empty-label-test");
    const clients = new Set<GatewayWsClient>([client]);
    setupClients(clients);

    let ok: boolean | undefined;
    let errorCode: string | undefined;
    await uiControlHandlers["ui.set_tab_label"]?.({
      params: { connId: client.connId, label: "   " },
      respond: (nextOk, _payload, error) => {
        ok = nextOk;
        errorCode = error?.code;
      },
    } as GatewayRequestHandlerOptions);

    expect(ok).toBe(false);
    expect(errorCode).toBe("INVALID_REQUEST");
  });
});

describe("ui-control targeted delivery (guide actions)", () => {
  function sockClient(connId: string, sent: string[]): GatewayWsClient {
    const c = makeUiClient(connId, `inst-${connId}`);
    (c as { socket: unknown }).socket = { send: (f: string) => sent.push(f), bufferedAmount: 0 };
    return c;
  }

  it("a connId-targeted dispatch goes to that socket only — never a broadcast", async () => {
    const { dispatchToUI } = await import("./ui-control.js");
    const aSent: string[] = [];
    const bSent: string[] = [];
    const broadcasts: string[] = [];
    const a = sockClient("conn-a", aSent);
    const b = sockClient("conn-b", bSent);
    setUIControlBroadcaster({
      clients: new Set([a, b]),
      broadcaster: { broadcast: (e: string) => void broadcasts.push(e) },
    });
    const p = dispatchToUI("guide", "highlight", { x: 1 }, { connId: "conn-b", timeoutMs: 200 });
    expect(aSent).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
    expect(bSent).toHaveLength(1);
    const frame = JSON.parse(bSent[0]!) as {
      event: string;
      payload: { requestId: string; view: string; connId: string };
    };
    expect(frame).toMatchObject({
      event: "ui.request",
      payload: { view: "guide", connId: "conn-b" },
    });
    // The browser answers → promise resolves with its payload.
    await uiControlHandlers["ui.response"]?.({
      req: { params: { requestId: frame.payload.requestId, ok: true, payload: { found: true } } },
      params: {},
      respond: () => undefined,
    } as unknown as GatewayRequestHandlerOptions);
    await expect(p).resolves.toMatchObject({ ok: true, payload: { found: true } });
  });

  it("routes nav.open_page to the tab bound to the caller's chat session", async () => {
    const aSent: string[] = [];
    const projectsSent: string[] = [];
    const broadcasts: string[] = [];
    const a = sockClient("conn-other", aSent);
    const projects = sockClient("conn-projects", projectsSent);
    setUIControlBroadcaster({
      clients: new Set([a, projects]),
      broadcaster: { broadcast: (event: string) => void broadcasts.push(event) },
    });
    bindUiSession("agent:main:projects-chat", projects.connId);

    const pending = invokeUIControlAction({
      action: "dispatch",
      view: "nav",
      op: "open_page",
      args: { target: "Projects" },
      sessionKey: "agent:main:projects-chat",
      timeoutMs: 500,
    });

    expect(aSent).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
    expect(projectsSent).toHaveLength(1);
    const frame = JSON.parse(projectsSent[0]!) as {
      payload: {
        requestId: string;
        view: string;
        action: string;
        args: Record<string, unknown>;
        connId: string;
      };
    };
    expect(frame.payload).toMatchObject({
      view: "nav",
      action: "open_page",
      args: { target: "Projects" },
      connId: projects.connId,
    });
    await uiControlHandlers["ui.response"]?.({
      req: {
        params: {
          requestId: frame.payload.requestId,
          ok: true,
          payload: { tab: "projects" },
        },
      },
      params: {},
      respond: () => undefined,
    } as unknown as GatewayRequestHandlerOptions);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      payload: { tab: "projects" },
      routingNote: expect.stringContaining("tab bound to this chat session"),
    });
  });

  it("routes nav.switch_tab to only the focused tab when no session is bound", async () => {
    const firstSent: string[] = [];
    const focusedSent: string[] = [];
    const first = sockClient("conn-first", firstSent);
    const focused = sockClient("conn-focused", focusedSent);
    setUIControlBroadcaster({
      clients: new Set([first, focused]),
      broadcaster: { broadcast: () => undefined },
    });
    noteUiClientActivity(focused.connId, { focused: true, visible: true, route: "/projects" });

    const pending = invokeUIControlAction({
      action: "dispatch",
      view: "nav",
      op: "switch_tab",
      args: { tab: "projects" },
      timeoutMs: 500,
    });

    expect(firstSent).toHaveLength(0);
    expect(focusedSent).toHaveLength(1);
    const frame = JSON.parse(focusedSent[0]!) as { payload: { requestId: string; connId: string } };
    expect(frame.payload.connId).toBe(focused.connId);
    await uiControlHandlers["ui.response"]?.({
      req: {
        params: {
          requestId: frame.payload.requestId,
          ok: true,
          payload: { tab: "projects" },
        },
      },
      params: {},
      respond: () => undefined,
    } as unknown as GatewayRequestHandlerOptions);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      routingNote: expect.stringContaining("focused tab"),
    });
  });

  it("lets an explicit connId override the focused tab for ordinary dispatch", async () => {
    const explicitSent: string[] = [];
    const focusedSent: string[] = [];
    const explicit = sockClient("conn-explicit", explicitSent);
    const focused = sockClient("conn-active", focusedSent);
    setUIControlBroadcaster({
      clients: new Set([explicit, focused]),
      broadcaster: { broadcast: () => undefined },
    });
    noteUiClientActivity(focused.connId, { focused: true, visible: true });

    const pending = invokeUIControlAction({
      action: "dispatch",
      view: "nav",
      op: "switch_tab",
      args: { tab: "projects" },
      connId: explicit.connId,
      timeoutMs: 500,
    });

    expect(focusedSent).toHaveLength(0);
    expect(explicitSent).toHaveLength(1);
    const frame = JSON.parse(explicitSent[0]!) as {
      payload: { requestId: string; connId: string };
    };
    expect(frame.payload.connId).toBe(explicit.connId);
    await uiControlHandlers["ui.response"]?.({
      req: {
        params: { requestId: frame.payload.requestId, ok: true, payload: { tab: "projects" } },
      },
      params: {},
      respond: () => undefined,
    } as unknown as GatewayRequestHandlerOptions);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      routingNote: expect.stringContaining("explicit connId"),
    });
  });

  it("a stale error from the ONE targeted tab is not swallowed waiting for others", async () => {
    const { dispatchToUI } = await import("./ui-control.js");
    const sent: string[] = [];
    const a = sockClient("conn-s", sent);
    setUIControlBroadcaster({
      clients: new Set([a, sockClient("conn-t", [])]),
      broadcaster: { broadcast: () => undefined },
    });
    const p = dispatchToUI("guide", "highlight", {}, { connId: "conn-s", timeoutMs: 500 });
    const id = (JSON.parse(sent[0]!) as { payload: { requestId: string } }).payload.requestId;
    await uiControlHandlers["ui.response"]?.({
      req: { params: { requestId: id, ok: false, error: "unknown action: highlight" } },
      params: {},
      respond: () => undefined,
    } as unknown as GatewayRequestHandlerOptions);
    await expect(p).resolves.toMatchObject({ ok: false, error: "unknown action: highlight" });
  });

  it("targeting a disconnected tab fails fast", async () => {
    const { dispatchToUI } = await import("./ui-control.js");
    setUIControlBroadcaster({
      clients: new Set([sockClient("conn-x", [])]),
      broadcaster: { broadcast: () => undefined },
    });
    await expect(dispatchToUI("guide", "clear", {}, { connId: "gone" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("ui.client.activity records presence for the calling tab", async () => {
    const c = sockClient("conn-act", []);
    setUIControlBroadcaster({ clients: new Set([c]), broadcaster: { broadcast: () => undefined } });
    let ok = false;
    await uiControlHandlers["ui.client.activity"]?.({
      params: { focused: true, visible: true, route: "/apikeys" },
      client: c,
      respond: (o: boolean) => void (ok = o),
    } as unknown as GatewayRequestHandlerOptions);
    const { uiClientActivity } = await import("../ui-guide.js");
    expect(ok).toBe(true);
    expect(uiClientActivity("conn-act")).toMatchObject({ focused: true, route: "/apikeys" });
  });
});

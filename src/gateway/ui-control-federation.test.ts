import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ForwardResult } from "../federation/hub-forward.js";
import {
  clearUiCapabilitiesCache,
  forwardUiControl,
  getRemoteUiCapabilities,
  listUiControlAudit,
  listWindowsAcrossNodes,
  nodeSupports,
  normalizeRoster,
  parseUiAddress,
  resolveNodeRef,
  UI_CONTROL_PROTOCOL,
  type ForwardFn,
  type UiNodeInfo,
} from "./ui-control-federation.js";

type Call = { nodeId: string; method: string; params: Record<string, unknown>; timeoutMs?: number };

/** Fake transport: `nodes` maps nodeId → method → handler. */
function fakeForward(
  nodes: Record<string, Record<string, (p: Record<string, unknown>) => ForwardResult>>,
): { forward: ForwardFn; calls: Call[] } {
  const calls: Call[] = [];
  const forward = (async (nodeId: string, method: string, params: unknown, timeoutMs?: number) => {
    calls.push({ nodeId, method, params: params as Record<string, unknown>, timeoutMs });
    const node = nodes[nodeId];
    if (!node)
      return { success: false, code: "INVOKE_FAILED", error: `Node ${nodeId} not connected` };
    const handler = node[method];
    if (!handler)
      return { success: false, code: "INVOKE_FAILED", error: `unknown method: ${method}` };
    return handler(params as Record<string, unknown>);
  }) as ForwardFn;
  return { forward, calls };
}

const caps2 = (): ForwardResult => ({
  success: true,
  payload: { protocol: UI_CONTROL_PROTOCOL, features: ["screenshot"], version: "2026.10.13" },
});

const roster: UiNodeInfo[] = [
  { nodeId: "master-1", name: "Studio PC", role: "master", isLocal: true, status: "online" },
  {
    nodeId: "CEO-Laptop_Main_5050",
    name: "CEO Laptop",
    role: "satellite",
    isLocal: false,
    status: "online",
  },
  { nodeId: "sat-b", name: "Living Room", role: "satellite", isLocal: false, status: "online" },
];

beforeEach(() => clearUiCapabilitiesCache());

describe("target addressing", () => {
  it("reads node from node, nodeId (tunnelled) and the compound tab address", () => {
    expect(parseUiAddress({ node: "laptop", tab: "Foxtrot" })).toEqual({
      node: "laptop",
      tab: "Foxtrot",
    });
    expect(parseUiAddress({ nodeId: "sat-b", tab: "Alpha" })).toEqual({
      node: "sat-b",
      tab: "Alpha",
    });
    expect(parseUiAddress({ tab: "laptop/Foxtrot" })).toEqual({ node: "laptop", tab: "Foxtrot" });
    expect(parseUiAddress({ window: "Bravo" })).toEqual({ node: undefined, tab: "Bravo" });
    // An explicit node wins; the tab is then taken literally.
    expect(parseUiAddress({ node: "x", tab: "a/b" })).toEqual({ node: "x", tab: "a/b" });
    expect(parseUiAddress({})).toEqual({ node: undefined, tab: undefined });
  });

  it("resolves node ids, names and unique fragments; refuses ambiguity", () => {
    expect(resolveNodeRef("CEO-Laptop_Main_5050", roster)).toMatchObject({
      nodeId: "CEO-Laptop_Main_5050",
    });
    expect(resolveNodeRef("ceo laptop", roster)).toMatchObject({ nodeId: "CEO-Laptop_Main_5050" });
    expect(resolveNodeRef("laptop", roster)).toMatchObject({ nodeId: "CEO-Laptop_Main_5050" });
    expect(resolveNodeRef("master", roster)).toMatchObject({ nodeId: "master-1" });
    const amb = resolveNodeRef("o", roster);
    expect("error" in amb && amb.error).toMatch(/ambiguous/);
    const none = resolveNodeRef("toaster", roster);
    expect("error" in none && none.error).toMatch(/no federation node matches/);
  });

  it("normalizes the federation.nodes.list roster", () => {
    const nodes = normalizeRoster({
      nodes: [
        {
          id: "local",
          name: "Me",
          isLocal: true,
          role: "master",
          status: "online",
          capabilities: { version: "1.2" },
        },
        { id: "s1", status: "connected", platform: "win32" },
        { name: "no id" },
      ],
    });
    expect(nodes).toEqual([
      {
        nodeId: "local",
        name: "Me",
        role: "master",
        isLocal: true,
        status: "online",
        version: "1.2",
        platform: undefined,
      },
      {
        nodeId: "s1",
        name: "s1",
        role: "satellite",
        isLocal: false,
        status: "connected",
        version: undefined,
        platform: "win32",
      },
    ]);
  });
});

describe("capability negotiation", () => {
  it("uses the node's advertised protocol and caches it", async () => {
    const { forward, calls } = fakeForward({ n: { "ui_control.capabilities": caps2 } });
    const a = await getRemoteUiCapabilities("n", forward, 1_000);
    const b = await getRemoteUiCapabilities("n", forward, 2_000);
    expect(a).toEqual(b);
    expect("caps" in a && a.caps.protocol).toBe(UI_CONTROL_PROTOCOL);
    expect(calls).toHaveLength(1);
  });

  it("treats a node without ui_control.capabilities as a legacy build", async () => {
    const { forward } = fakeForward({ old: {} });
    const r = await getRemoteUiCapabilities("old", forward);
    expect(r).toEqual({ caps: { protocol: 1, features: [], legacy: true } });
    if ("caps" in r) {
      expect(nodeSupports(r.caps, "dispatch")).toBe(true);
      expect(nodeSupports(r.caps, "screenshot")).toBe(false);
      expect(nodeSupports(r.caps, "navigate")).toBe(false);
    }
  });

  it("reports an offline node as NODE_UNREACHABLE (not as needing an update)", async () => {
    const { forward } = fakeForward({});
    const r = await getRemoteUiCapabilities("gone", forward);
    expect(r).toMatchObject({ code: "NODE_UNREACHABLE" });
  });
});

describe("proxy routing", () => {
  it("forwards the action with origin + hop count and strips the caller's session", async () => {
    const { forward, calls } = fakeForward({
      laptop: {
        "ui_control.capabilities": caps2,
        "ui_control.invoke": (p) => ({
          success: true,
          payload: { ok: true, resolved: { title: "Research" }, echo: p },
        }),
      },
    });
    const res = await forwardUiControl(
      "laptop",
      {
        action: "navigate",
        tab: "Foxtrot",
        route: "/research",
        sessionKey: "agent:main:main",
        node: "laptop",
      },
      { localNodeId: "master-1", localName: "Studio PC", forward },
    );
    expect(res).toMatchObject({ ok: true, node: "laptop", resolved: { title: "Research" } });
    expect(typeof res.latencyMs).toBe("number");
    const invoke = calls.find((c) => c.method === "ui_control.invoke")!;
    expect(invoke.params).toMatchObject({
      action: "navigate",
      tab: "Foxtrot",
      route: "/research",
      origin: { nodeId: "master-1", name: "Studio PC", sessionKey: "agent:main:main", hops: 1 },
    });
    expect(invoke.params.sessionKey).toBeUndefined();
    // No hub/satellite in tests → treated like a satellite hop: `node` kept for an older master.
    expect(invoke.params.node).toBe("laptop");
    expect(invoke.timeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it("gives screenshots a longer transport timeout", async () => {
    const { forward, calls } = fakeForward({
      n: {
        "ui_control.capabilities": caps2,
        "ui_control.invoke": () => ({ success: true, payload: { ok: true } }),
      },
    });
    await forwardUiControl("n", { action: "screenshot" }, { localNodeId: "m", forward });
    expect(calls.find((c) => c.method === "ui_control.invoke")!.timeoutMs).toBe(45_000);
  });

  it("refuses a request that has already hopped too often (routing loop guard)", async () => {
    const { forward, calls } = fakeForward({});
    const res = await forwardUiControl(
      "n",
      { action: "dispatch", origin: { nodeId: "a", hops: 3 } },
      { localNodeId: "m", forward },
    );
    expect(res).toMatchObject({ ok: false, code: "ROUTING_LOOP" });
    expect(calls).toHaveLength(0);
  });

  it("keeps the original origin across a relay hop (sat → master → sat)", async () => {
    const { forward, calls } = fakeForward({
      "sat-b": {
        "ui_control.capabilities": caps2,
        "ui_control.invoke": () => ({ success: true, payload: { ok: true } }),
      },
    });
    await forwardUiControl(
      "sat-b",
      { action: "list_tabs", origin: { nodeId: "sat-a", name: "Laptop", hops: 1 } },
      { localNodeId: "master-1", forward },
    );
    expect(calls.find((c) => c.method === "ui_control.invoke")!.params.origin).toEqual({
      nodeId: "sat-a",
      name: "Laptop",
      sessionKey: undefined,
      hops: 2,
    });
  });

  it("surfaces transport failures with the node id instead of running locally", async () => {
    const { forward } = fakeForward({
      n: {
        "ui_control.capabilities": caps2,
        "ui_control.invoke": () => ({
          success: false,
          code: "INVOKE_FAILED",
          error: "socket closed",
        }),
      },
    });
    const res = await forwardUiControl("n", { action: "dispatch" }, { localNodeId: "m", forward });
    expect(res).toEqual({ ok: false, code: "INVOKE_FAILED", node: "n", error: "socket closed" });
  });

  it("logs outbound actions per node", async () => {
    const { forward } = fakeForward({
      audited: {
        "ui_control.capabilities": caps2,
        "ui_control.invoke": () => ({ success: true, payload: { ok: true } }),
      },
    });
    await forwardUiControl(
      "audited",
      { action: "dispatch", view: "grid", op: "list_panels", tab: "Echo" },
      { localNodeId: "m", forward },
    );
    const [entry] = listUiControlAudit({ node: "audited", limit: 1 });
    expect(entry).toMatchObject({
      direction: "outbound",
      fromNode: "m",
      toNode: "audited",
      action: "dispatch",
      view: "grid",
      op: "list_panels",
      tab: "Echo",
      ok: true,
    });
  });
});

describe("version skew", () => {
  it("returns NODE_UPDATE_REQUIRED with the remote-update path for a legacy node", async () => {
    const { forward, calls } = fakeForward({
      old: { "ui_control.invoke": () => ({ success: true, payload: { ok: true } }) },
    });
    const res = await forwardUiControl(
      "old",
      { action: "screenshot", tab: "Foxtrot" },
      { localNodeId: "m", nodeName: "CEO Laptop", forward },
    );
    expect(res).toMatchObject({
      ok: false,
      code: "NODE_UPDATE_REQUIRED",
      node: "old",
      remoteProtocol: 1,
      update: { method: "federation.node.update", params: { nodeId: "old" } },
    });
    expect(String(res.error)).toMatch(/^Update node CEO Laptop \(old\)/);
    expect(calls.some((c) => c.method === "ui_control.invoke")).toBe(false);
  });

  it("still drives a legacy node for actions it already serves", async () => {
    const { forward } = fakeForward({
      old: { "ui_control.invoke": () => ({ success: true, payload: { ok: true, tabs: [] } }) },
    });
    const res = await forwardUiControl(
      "old",
      { action: "list_tabs" },
      { localNodeId: "m", forward },
    );
    expect(res).toMatchObject({ ok: true, tabs: [], remoteProtocol: 1 });
  });

  it("maps a remote 'unknown action' answer to NODE_UPDATE_REQUIRED", async () => {
    const { forward } = fakeForward({
      n: {
        "ui_control.capabilities": () => ({
          success: true,
          payload: { protocol: 2, features: [] },
        }),
        "ui_control.invoke": () => ({
          success: true,
          payload: { ok: false, error: "unknown action: mirror" },
        }),
      },
    });
    const res = await forwardUiControl("n", { action: "mirror" }, { localNodeId: "m", forward });
    expect(res.code).toBe("NODE_UPDATE_REQUIRED");
  });

  it("never forwards the cross-node listings themselves", async () => {
    const { forward, calls } = fakeForward({});
    const res = await forwardUiControl(
      "n",
      { action: "list_windows" },
      { localNodeId: "m", forward },
    );
    expect(res).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });
});

describe("cross-node listing", () => {
  it("lists windows on every node with status, latency, protocol and node-qualified addresses", async () => {
    const now = Date.now();
    const { forward } = fakeForward({
      "CEO-Laptop_Main_5050": {
        "ui_control.capabilities": caps2,
        "ui_control.invoke": () => ({
          success: true,
          payload: {
            nodeId: "CEO-Laptop_Main_5050",
            tabs: [
              {
                connId: "c9",
                codename: "Foxtrot",
                label: "Foxtrot",
                route: "/chat",
                focused: true,
                lastSeenAt: now,
              },
            ],
          },
        }),
      },
      "sat-b": { "ui_control.invoke": () => ({ success: true, payload: { tabs: [] } }) },
    });
    const listing = await listWindowsAcrossNodes({
      localNodeId: "master-1",
      localTabs: () => [{ connId: "c1", codename: "Alpha", label: "Desk", route: "/grid" }],
      roster: [
        ...roster,
        {
          nodeId: "sat-off",
          name: "Old Box",
          role: "satellite",
          isLocal: false,
          status: "disconnected",
        },
      ],
      forward,
    });
    expect(listing.windows.map((w) => w.address)).toEqual(["Studio PC/Desk", "CEO Laptop/Foxtrot"]);
    const laptop = listing.nodes.find((n) => n.nodeId === "CEO-Laptop_Main_5050")!;
    expect(laptop).toMatchObject({
      online: true,
      protocol: 2,
      version: "2026.10.13",
      updateRequired: false,
    });
    expect(laptop.windows[0]).toMatchObject({
      node: "CEO-Laptop_Main_5050",
      codename: "Foxtrot",
      route: "/chat",
      focused: true,
      isLocal: false,
    });
    expect(listing.nodes.find((n) => n.nodeId === "sat-b")).toMatchObject({
      online: true,
      protocol: 1,
      updateRequired: true,
    });
    expect(listing.nodes.find((n) => n.nodeId === "sat-off")).toMatchObject({
      online: false,
      windows: [],
    });
  });

  it("marks a node that never answers as timed out without blocking the rest", async () => {
    vi.useFakeTimers();
    try {
      const hang = (() => new Promise(() => undefined)) as unknown as ForwardFn;
      const p = listWindowsAcrossNodes({
        localNodeId: "master-1",
        localTabs: () => [],
        roster: roster.slice(0, 2),
        forward: hang,
        perNodeTimeoutMs: 500,
      });
      await vi.advanceTimersByTimeAsync(600);
      const listing = await p;
      expect(listing.nodes[1]).toMatchObject({ online: false, code: "NODE_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("satellite roster", () => {
  it("takes the full roster from the master and re-marks self + master", async () => {
    const { rosterFromMaster } = await import("./ui-control-federation.js");
    const { forward, calls } = fakeForward({
      master: {
        "federation.nodes.list": () => ({
          success: true,
          payload: {
            nodes: [
              {
                id: "side-master",
                name: "Side Master",
                isLocal: true,
                role: "master",
                status: "online",
              },
              { id: "sat-a", name: "Side Laptop", role: "satellite", status: "online" },
              { id: "sat-b", name: "Side Desk", role: "satellite", status: "online" },
            ],
          },
        }),
      },
    });
    const nodes = await rosterFromMaster(forward, "sat-a");
    expect(calls[0]).toMatchObject({ nodeId: "master", method: "federation.nodes.list" });
    expect(nodes?.map((n) => [n.nodeId, n.role, n.isLocal])).toEqual([
      ["side-master", "master", false],
      ["sat-a", "satellite", true],
      ["sat-b", "satellite", false],
    ]);
    // A sibling is now addressable by name from the satellite.
    expect(resolveNodeRef("Side Desk", nodes!)).toMatchObject({ nodeId: "sat-b" });
  });

  it("returns null when the master cannot be asked (caller falls back to the local roster)", async () => {
    const { rosterFromMaster } = await import("./ui-control-federation.js");
    const { forward } = fakeForward({});
    expect(await rosterFromMaster(forward, "sat-a")).toBeNull();
  });
});

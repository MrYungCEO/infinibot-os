import { describe, expect, it } from "vitest";

import { addressArgs, listFederationWindows, routeChoices } from "./federation-ui-control";
import type { GatewayBrowserClient } from "./gateway";

function client(handlers: Record<string, (p: Record<string, unknown>) => unknown>): GatewayBrowserClient {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      const h = handlers[method];
      if (!h) throw new Error(`unknown method: ${method}`);
      return h(params ?? {});
    },
  } as unknown as GatewayBrowserClient;
}

describe("federation-ui-control", () => {
  it("addresses local windows by connId and remote ones by node + codename", () => {
    const base = { label: "Desk", codename: "Foxtrot", connId: "c1" };
    expect(addressArgs({ ...base, node: "me", isLocal: true })).toEqual({ connId: "c1" });
    expect(addressArgs({ ...base, node: "laptop", isLocal: false })).toEqual({ node: "laptop", tab: "Foxtrot" });
  });

  it("uses list_windows when the gateway has it", async () => {
    const listing = await listFederationWindows(
      client({
        "ui_control.invoke": (p) =>
          p.action === "list_windows" ? { ok: true, localNode: "m", nodes: [{ nodeId: "m", windows: [] }], windows: [] } : {},
      }),
    );
    expect(listing).toMatchObject({ localNode: "m", nodes: [{ nodeId: "m" }] });
    expect(listing.legacy).toBeUndefined();
  });

  it("falls back to list_tabs + federation.nodes.list on an older gateway", async () => {
    const listing = await listFederationWindows(
      client({
        "ui_control.invoke": (p) =>
          p.action === "list_tabs"
            ? { nodeId: "lap", tabs: [{ connId: "r1", codename: "Foxtrot", label: "Foxtrot" }] }
            : { ok: false, error: "unknown action: list_windows" },
        "ui.list_tabs": () => ({ nodeId: "m", tabs: [{ connId: "l1", codename: "Alpha", label: "Alpha" }] }),
        "federation.nodes.list": () => ({
          nodes: [
            { id: "m", name: "Studio", isLocal: true, role: "master" },
            { id: "lap", name: "Laptop", status: "online" },
          ],
        }),
      }),
    );
    expect(listing.legacy).toBe(true);
    expect(listing.windows.map((w) => w.address)).toEqual(["Studio/Alpha", "Laptop/Foxtrot"]);
    expect(listing.windows[1]).toMatchObject({ node: "lap", isLocal: false });
  });

  it("offers routable screens for the navigate picker", () => {
    const routes = routeChoices();
    expect(routes.some((r) => r.route === "/research")).toBe(true);
    expect(routes.every((r) => r.route.startsWith("/"))).toBe(true);
  });
});

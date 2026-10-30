/**
 * Browser-side client for cross-node UI control (ui_control.invoke over the
 * gateway, which forwards to other federation nodes). Shared by the device
 * switcher, the remote-screen mirror and the top-bar tab pills.
 */

import type { GatewayBrowserClient } from "./gateway.js";
import { TAB_PATHS, titleForTab, type Tab } from "./navigation.js";

export type FedWindow = {
  node: string;
  nodeName: string;
  address: string;
  connId: string;
  codename: string;
  label: string;
  title?: string;
  route?: string;
  focused?: boolean;
  visible?: boolean;
  lastSeenAt?: number;
  isLocal: boolean;
};

export type FedNode = {
  nodeId: string;
  name: string;
  role: string;
  isLocal: boolean;
  status: string;
  online: boolean;
  version?: string;
  platform?: string;
  latencyMs?: number;
  protocol?: number;
  updateRequired?: boolean;
  error?: string;
  code?: string;
  windows: FedWindow[];
};

export type FedListing = { localNode: string; nodes: FedNode[]; windows: FedWindow[]; legacy?: boolean };

export type UiResult = Record<string, unknown> & { ok?: boolean; error?: string; code?: string };

export async function invokeUi(client: GatewayBrowserClient, args: Record<string, unknown>): Promise<UiResult> {
  return (await client.request<UiResult>("ui_control.invoke", args)) ?? {};
}

/** Older gateways have no list_windows: rebuild it from list_tabs + federation.nodes.list. */
async function legacyListing(client: GatewayBrowserClient): Promise<FedListing> {
  const local = await client.request<{ nodeId?: string; tabs?: FedWindow[] }>("ui.list_tabs", {}).catch(() => null);
  const localNode = local?.nodeId ?? "local";
  const fed = await client
    .request<{ nodes?: Array<{ id?: string; name?: string; status?: string; isLocal?: boolean; role?: string }> }>(
      "federation.nodes.list",
      {},
    )
    .catch(() => null);
  const nodes: FedNode[] = [];
  const asWindows = (nodeId: string, name: string, isLocal: boolean, tabs: unknown): FedWindow[] =>
    (Array.isArray(tabs) ? (tabs as FedWindow[]) : []).map((t) => ({
      ...t,
      node: nodeId,
      nodeName: name,
      address: `${name}/${t.label || t.codename}`,
      label: t.label || t.codename,
      isLocal,
    }));
  const localEntry = fed?.nodes?.find((n) => n.isLocal);
  nodes.push({
    nodeId: localNode,
    name: localEntry?.name ?? "This device",
    role: localEntry?.role ?? "standalone",
    isLocal: true,
    status: "online",
    online: true,
    windows: asWindows(localNode, localEntry?.name ?? "This device", true, local?.tabs),
  });
  for (const n of fed?.nodes ?? []) {
    if (!n.id || n.isLocal) continue;
    const started = performance.now();
    const res = await invokeUi(client, { action: "list_tabs", node: n.id }).catch((e: unknown) => ({ ok: false, error: String(e) }) as UiResult);
    nodes.push({
      nodeId: n.id,
      name: n.name ?? n.id,
      role: n.role ?? "satellite",
      isLocal: false,
      status: n.status ?? "online",
      online: res.ok !== false,
      latencyMs: Math.round(performance.now() - started),
      error: res.ok === false ? String(res.error ?? "unreachable") : undefined,
      windows: asWindows(n.id, n.name ?? n.id, false, res.tabs),
    });
  }
  return { localNode, nodes, windows: nodes.flatMap((n) => n.windows), legacy: true };
}

export async function listFederationWindows(client: GatewayBrowserClient): Promise<FedListing> {
  const res = await invokeUi(client, { action: "list_windows" }).catch(() => null);
  if (res && Array.isArray(res.nodes)) {
    return {
      localNode: String(res.localNode ?? "local"),
      nodes: res.nodes as FedNode[],
      windows: (res.windows as FedWindow[]) ?? [],
    };
  }
  return legacyListing(client);
}

/** Address args for a window; the local node is sent without `node`. */
export function addressArgs(win: { node: string; isLocal: boolean; label: string; codename: string; connId: string }) {
  return win.isLocal ? { connId: win.connId } : { node: win.node, tab: win.codename };
}

export function navigateWindow(client: GatewayBrowserClient, win: FedWindow, route: string): Promise<UiResult> {
  return invokeUi(client, { action: "navigate", route, ...addressArgs(win) });
}

export function screenshotWindow(
  client: GatewayBrowserClient,
  target: { node?: string; tab?: string; connId?: string },
  args: { maxWidth?: number; quality?: number } = {},
): Promise<UiResult> {
  return invokeUi(client, { action: "screenshot", ...target, args, timeoutMs: 20_000 });
}

/** Show `source`'s screen live inside `display`. */
export function mirrorWindow(client: GatewayBrowserClient, display: FedWindow, source: FedWindow): Promise<UiResult> {
  return invokeUi(client, {
    action: "mirror",
    ...addressArgs(display),
    source: { node: source.isLocal ? undefined : source.node, tab: source.codename, label: `${source.nodeName} · ${source.label}` },
  });
}

export function updateNode(client: GatewayBrowserClient, nodeId: string): Promise<unknown> {
  return client.request("federation.node.update", { nodeId });
}

/** Routable screens for the "navigate to" picker. */
export function routeChoices(): Array<{ route: string; title: string }> {
  const out: Array<{ route: string; title: string }> = [];
  for (const [tab, route] of Object.entries(TAB_PATHS)) {
    if (!route) continue;
    let title = tab;
    try {
      title = titleForTab(tab as Tab) || tab;
    } catch {
      /* unknown tab id */
    }
    out.push({ route, title });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export function timeAgo(ms?: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

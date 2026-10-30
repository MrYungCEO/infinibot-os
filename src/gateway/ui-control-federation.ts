/**
 * Cross-node ui_control: one target model for every federation node.
 *
 * Every UI target is addressed as `{ node, tab }` — e.g. node "laptop" /
 * window "Foxtrot" (the NATO codename each InfiniBot tab shows in its title
 * bar). `ui_control` accepts that address on any node and proxies the same
 * action to the owning node's gateway over the existing federation transport
 * (`forwardGatewayCall`: master→sat via the hub, sat→master and sat→sat
 * tunnelled through the master). Results come back unchanged plus
 * `{ node, latencyMs }`.
 *
 * Before forwarding, the target's ui_control capabilities are negotiated
 * (`ui_control.capabilities`, cached). An older node that lacks the method or
 * the action gets a clear NODE_UPDATE_REQUIRED error that points at the
 * existing remote-update path (`federation.node.update`).
 *
 * Every cross-node action is logged on both ends (outbound on the caller,
 * inbound on the target) in a per-node ring buffer (`ui_control.audit`) and
 * in the federation audit log.
 */

import { forwardGatewayCall, type ForwardResult } from "../federation/hub-forward.js";
import { getFederationHub } from "../federation/hub.js";
import { getLocalNodeId, isLocalNodeId } from "../federation/local-node.js";
import { getFederationSatellite } from "../federation/satellite.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { coerceString } from "../shared/text/coerce.js";

const log = createSubsystemLogger("ui-control").child("federation");

/** Bump when the cross-node ui_control contract gains something a peer must know about. */
export const UI_CONTROL_PROTOCOL = 2;

/** Features a protocol-2 node serves; peers check these before relying on them. */
export const UI_CONTROL_FEATURES = [
  "node-routing",
  "node-names",
  "list_nodes",
  "list_windows",
  "screenshot",
  "mirror",
  "window-state",
  "audit",
] as const;

/**
 * Actions an older (pre-capabilities) node is known to serve through
 * ui_control.invoke. Anything else needs the node updated first.
 */
export const LEGACY_REMOTE_ACTIONS = new Set([
  "list_clients",
  "list_tabs",
  "set_label",
  "focus_tab",
  "list_views",
  "get_state",
  "dispatch",
]);

/** Actions that only run on the receiving node and must never be forwarded. */
const NEVER_FORWARD = new Set(["list_nodes", "list_windows"]);

const MAX_HOPS = 3;
const CAPS_TTL_MS = 60_000;

export type ForwardFn = <T = unknown>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
) => Promise<ForwardResult<T>>;

export type UiNodeInfo = {
  nodeId: string;
  name: string;
  role: string;
  isLocal: boolean;
  status: string;
  version?: string;
  platform?: string;
};

export type UiControlCapabilities = {
  protocol: number;
  features: string[];
  nodeId?: string;
  version?: string;
  gitCommit?: string | null;
  legacy?: boolean;
};

export type UiControlOrigin = {
  nodeId: string;
  name?: string;
  sessionKey?: string;
  hops: number;
};

// ── addressing ──────────────────────────────────────────────────────────────

/**
 * Pull the node + tab address out of ui_control params. Accepts:
 *   - `node` (agent/UI callers) or `nodeId` (re-attached by forwardGatewayCall
 *     when a satellite tunnels through the master),
 *   - `window` as an alias of `tab`,
 *   - a compound `tab: "laptop/Foxtrot"` when no node was given.
 */
export function parseUiAddress(params: {
  node?: unknown;
  nodeId?: unknown;
  tab?: unknown;
  window?: unknown;
}): { node?: string; tab?: string } {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  let node = str(params.node) ?? str(params.nodeId);
  let tab = str(params.tab) ?? str(params.window);
  if (!node && tab) {
    const slash = tab.lastIndexOf("/");
    if (slash > 0 && slash < tab.length - 1) {
      node = tab.slice(0, slash).trim();
      tab = tab.slice(slash + 1).trim();
    }
  }
  return { node, tab };
}

/** The id this process answers to for ui_control (config id, hub id or "local"). */
export function uiLocalNodeId(configNodeId?: string): string {
  return getLocalNodeId() ?? (configNodeId && configNodeId.trim() ? configNodeId.trim() : "local");
}

/** True when `node` names this process (empty, "local", own id, master alias on the master). */
export function isUiLocalNode(node: string | undefined, configNodeId?: string): boolean {
  if (!node) return true;
  if (isLocalNodeId(node)) return true;
  return Boolean(configNodeId) && node === configNodeId;
}

/**
 * Resolve a human node reference ("laptop", "CEO-Laptop", a node id) against
 * the roster: exact id → exact name → unique id/name substring.
 */
export function resolveNodeRef(
  ref: string,
  nodes: UiNodeInfo[],
): { nodeId: string; node?: UiNodeInfo } | { error: string; candidates: string[] } {
  const want = ref.trim().toLowerCase();
  if (!want) return { error: "node is empty", candidates: [] };
  const byId = nodes.find((n) => n.nodeId.toLowerCase() === want);
  if (byId) return { nodeId: byId.nodeId, node: byId };
  const byName = nodes.filter((n) => n.name.toLowerCase() === want);
  if (byName.length === 1) return { nodeId: byName[0]!.nodeId, node: byName[0] };
  const loose = nodes.filter(
    (n) => n.nodeId.toLowerCase().includes(want) || n.name.toLowerCase().includes(want),
  );
  if (loose.length === 1) return { nodeId: loose[0]!.nodeId, node: loose[0] };
  if (want === "master") {
    const master = nodes.find((n) => n.role === "master");
    if (master) return { nodeId: master.nodeId, node: master };
    return { nodeId: "master" };
  }
  const candidates = (loose.length ? loose : nodes).map((n) => `${n.name} (${n.nodeId})`);
  return {
    error:
      loose.length > 1
        ? `node "${ref}" is ambiguous: ${candidates.join(", ")}`
        : `no federation node matches "${ref}". Known: ${candidates.join(", ") || "(none)"}`,
    candidates,
  };
}

// ── roster ──────────────────────────────────────────────────────────────────

type RawNode = {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  isLocal?: unknown;
  status?: unknown;
  platform?: unknown;
  capabilities?: { version?: unknown; platform?: unknown } | null;
};

export function normalizeRoster(raw: unknown): UiNodeInfo[] {
  const nodes = (raw as { nodes?: RawNode[] } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: UiNodeInfo[] = [];
  for (const n of nodes) {
    const nodeId = typeof n?.id === "string" ? n.id : "";
    if (!nodeId) continue;
    const caps = n.capabilities ?? undefined;
    out.push({
      nodeId,
      name: typeof n.name === "string" && n.name ? n.name : nodeId,
      role: typeof n.role === "string" ? n.role : "satellite",
      isLocal: n.isLocal === true,
      status: typeof n.status === "string" ? n.status : "online",
      version: typeof caps?.version === "string" ? caps.version : undefined,
      platform:
        typeof n.platform === "string"
          ? n.platform
          : typeof caps?.platform === "string"
            ? caps.platform
            : undefined,
    });
  }
  return out;
}

/**
 * A satellite's own federation.nodes.list only knows the siblings the master
 * happened to state-sync, so ask the master (the router) for its roster and
 * re-mark which entry is this node. Null when the master can't be asked.
 */
export async function rosterFromMaster(
  forward: ForwardFn = forwardGatewayCall,
  selfId: string | null = getLocalNodeId(),
): Promise<UiNodeInfo[] | null> {
  const res = await forward("master", "federation.nodes.list", {}, 6_000);
  if (!res.success) return null;
  const nodes = normalizeRoster(res.payload);
  if (!nodes.length) return null;
  return nodes.map((n) => {
    // The master lists itself as its local node; from here it is the master peer.
    if (n.isLocal) return { ...n, isLocal: false, role: "master", status: "online" };
    return selfId && n.nodeId === selfId ? { ...n, isLocal: true } : n;
  });
}

/** The federation roster as this node sees it (same source as federation.nodes.list). */
export async function listFederationNodes(): Promise<UiNodeInfo[]> {
  if (!getFederationHub() && !getFederationSatellite()) return [];
  if (!getFederationHub() && getFederationSatellite()?.getState?.() === "connected") {
    const fromMaster = await rosterFromMaster().catch(() => null);
    if (fromMaster) return fromMaster;
  }
  try {
    const { federationHandlers } = await import("./server-methods/federation.js");
    const handler = federationHandlers["federation.nodes.list"];
    if (!handler) return [];
    let payload: unknown;
    await handler({
      req: { type: "req", id: "ui-control-roster", method: "federation.nodes.list", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: (_ok: boolean, p?: unknown) => {
        payload = p;
      },
      context: {} as never,
    } as unknown as Parameters<typeof handler>[0]);
    return normalizeRoster(payload);
  } catch (err) {
    log.debug(`federation roster unavailable: ${String(err)}`);
    return [];
  }
}

/** Resolve a node reference to an id via the roster; unknown refs pass through as raw ids. */
export async function resolveTargetNodeId(ref: string): Promise<string> {
  const roster = await listFederationNodes();
  const resolved = resolveNodeRef(ref, roster);
  return "nodeId" in resolved ? resolved.nodeId : ref;
}

// ── capability negotiation ──────────────────────────────────────────────────

const capsCache = new Map<string, { at: number; caps: UiControlCapabilities }>();

export function clearUiCapabilitiesCache(): void {
  capsCache.clear();
}

const UNKNOWN_METHOD_RE = /unknown method|no handler|method not found|not found: ui_control/i;

export async function localUiCapabilities(nodeId: string): Promise<UiControlCapabilities> {
  let version: string | undefined;
  let gitCommit: string | null | undefined;
  try {
    const { getLocalVersionInfo } = await import("../infra/version-info.js");
    const info = await getLocalVersionInfo();
    version = info.version ?? undefined;
    gitCommit = info.gitCommit ?? null;
  } catch {
    /* version is informational */
  }
  return {
    protocol: UI_CONTROL_PROTOCOL,
    features: [...UI_CONTROL_FEATURES],
    nodeId,
    version,
    gitCommit,
  };
}

/**
 * Ask a node what its ui_control speaks. A node without the method is an
 * older build: it still serves the LEGACY_REMOTE_ACTIONS via ui_control.invoke.
 */
export async function getRemoteUiCapabilities(
  nodeId: string,
  forward: ForwardFn = forwardGatewayCall,
  now = Date.now(),
): Promise<{ caps: UiControlCapabilities } | { error: string; code: string }> {
  const hit = capsCache.get(nodeId);
  if (hit && now - hit.at < CAPS_TTL_MS) return { caps: hit.caps };
  const res = await forward<UiControlCapabilities>(
    nodeId,
    "ui_control.capabilities",
    forwardHopParams(nodeId, {}),
    8_000,
  );
  let caps: UiControlCapabilities;
  if (res.success && res.payload && typeof res.payload.protocol === "number") {
    caps = res.payload;
  } else if (res.success || UNKNOWN_METHOD_RE.test(res.error ?? "")) {
    caps = { protocol: 1, features: [], legacy: true };
  } else {
    return {
      code: res.code === "NOT_FEDERATED" ? "NOT_FEDERATED" : "NODE_UNREACHABLE",
      error: res.error ?? `node ${nodeId} did not answer`,
    };
  }
  capsCache.set(nodeId, { at: now, caps });
  return { caps };
}

export function nodeSupports(caps: UiControlCapabilities, action: string): boolean {
  if (caps.protocol >= UI_CONTROL_PROTOCOL) return true;
  return LEGACY_REMOTE_ACTIONS.has(action);
}

export function updateRequiredError(
  nodeId: string,
  action: string,
  caps: Partial<UiControlCapabilities>,
  nodeName?: string,
): Record<string, unknown> {
  const label = nodeName && nodeName !== nodeId ? `${nodeName} (${nodeId})` : nodeId;
  return {
    ok: false,
    code: "NODE_UPDATE_REQUIRED",
    node: nodeId,
    error:
      `Update node ${label}: it runs an older InfiniBot build` +
      (caps.version ? ` (${caps.version})` : "") +
      ` whose UI control does not support "${action}". ` +
      "Update it from the Device switcher (Update button) or with federation.node.update — the node pulls, builds and restarts — then retry.",
    remoteProtocol: caps.protocol ?? 1,
    requiredProtocol: UI_CONTROL_PROTOCOL,
    update: { method: "federation.node.update", params: { nodeId } },
  };
}

// ── forwarding ──────────────────────────────────────────────────────────────

/**
 * Params for the next hop. The master→satellite hop drops node/nodeId (the
 * satellite runs it locally, and an older satellite must not try to re-route
 * it). A satellite tunnelling up keeps `node` so even an older master, which
 * only reads `node`, forwards it on to the sibling.
 */
function forwardHopParams(
  targetNode: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const { node: _n, nodeId: _id, ...rest } = params;
  if (getFederationHub()) return rest;
  return { ...rest, node: targetNode };
}

export type UiAuditEntry = {
  at: number;
  direction: "outbound" | "inbound";
  fromNode: string;
  toNode: string;
  action: string;
  view?: string;
  op?: string;
  tab?: string;
  sessionKey?: string;
  ok: boolean;
  code?: string;
  error?: string;
  latencyMs?: number;
};

const AUDIT_MAX = 300;
const auditRing: UiAuditEntry[] = [];

export function recordUiControlAudit(entry: UiAuditEntry): void {
  auditRing.push(entry);
  if (auditRing.length > AUDIT_MAX) auditRing.splice(0, auditRing.length - AUDIT_MAX);
  void (async () => {
    try {
      const { audit } = await import("../federation/audit-log.js");
      const ctx = {
        nodeId: entry.direction === "outbound" ? entry.toNode : entry.fromNode,
        sessionKey: entry.sessionKey,
        operation: `ui_control.${entry.action}`,
        resource: [entry.view, entry.op, entry.tab].filter(Boolean).join(":") || undefined,
        durationMs: entry.latencyMs,
        metadata: { direction: entry.direction, fromNode: entry.fromNode, toNode: entry.toNode },
      };
      if (entry.ok) audit.success("ui.control", ctx);
      else audit.failure("ui.control", entry.error ?? entry.code ?? "failed", ctx);
    } catch {
      /* the ring buffer is the primary record; disk audit is best-effort */
    }
  })();
}

export function listUiControlAudit(filter: { node?: string; limit?: number } = {}): UiAuditEntry[] {
  const limit = Math.max(1, Math.min(AUDIT_MAX, filter.limit ?? 50));
  const rows = filter.node
    ? auditRing.filter((e) => e.fromNode === filter.node || e.toNode === filter.node)
    : auditRing;
  return rows.slice(-limit).reverse();
}

/** Forward timeouts: the remote browser gets its own timeout plus transport slack. */
function forwardTimeoutFor(action: string, timeoutMs?: number): number {
  const base = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
  const floor = action === "screenshot" ? 45_000 : 30_000;
  return Math.max(floor, base + 5_000);
}

export async function forwardUiControl(
  nodeId: string,
  params: Record<string, unknown>,
  ctx: {
    localNodeId: string;
    localName?: string;
    nodeName?: string;
    forward?: ForwardFn;
  },
): Promise<Record<string, unknown>> {
  const forward = ctx.forward ?? forwardGatewayCall;
  const action = typeof params.action === "string" ? params.action : "";
  const prevOrigin = params.origin as Partial<UiControlOrigin> | undefined;
  const hops = (typeof prevOrigin?.hops === "number" ? prevOrigin.hops : 0) + 1;
  const started = Date.now();
  const audit = (ok: boolean, extra: Partial<UiAuditEntry> = {}) =>
    recordUiControlAudit({
      at: started,
      direction: "outbound",
      fromNode: prevOrigin?.nodeId ?? ctx.localNodeId,
      toNode: nodeId,
      action,
      view: typeof params.view === "string" ? params.view : undefined,
      op: typeof params.op === "string" ? params.op : undefined,
      tab: typeof params.tab === "string" ? params.tab : undefined,
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
      ok,
      latencyMs: Date.now() - started,
      ...extra,
    });

  if (hops > MAX_HOPS) {
    const err = {
      ok: false,
      code: "ROUTING_LOOP",
      error: `ui_control to ${nodeId} exceeded ${MAX_HOPS} hops`,
    };
    audit(false, { code: "ROUTING_LOOP", error: err.error });
    return err;
  }
  if (NEVER_FORWARD.has(action)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      error: `${action} is answered locally; omit node`,
    };
  }

  const negotiated = await getRemoteUiCapabilities(nodeId, forward);
  if ("error" in negotiated) {
    audit(false, { code: negotiated.code, error: negotiated.error });
    return { ok: false, code: negotiated.code, node: nodeId, error: negotiated.error };
  }
  if (!nodeSupports(negotiated.caps, action)) {
    const err = updateRequiredError(nodeId, action, negotiated.caps, ctx.nodeName);
    audit(false, { code: "NODE_UPDATE_REQUIRED", error: String(err.error) });
    return err;
  }

  const origin: UiControlOrigin = {
    nodeId: prevOrigin?.nodeId ?? ctx.localNodeId,
    name: prevOrigin?.name ?? ctx.localName,
    sessionKey:
      prevOrigin?.sessionKey ??
      (typeof params.sessionKey === "string" ? params.sessionKey : undefined),
    hops,
  };
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  // A peer's session binding means nothing on the target node; it picks its
  // own focused/most-recent tab unless a tab was named.
  const { sessionKey: _sk, ...rest } = params;
  const res = await forward<Record<string, unknown>>(
    nodeId,
    "ui_control.invoke",
    forwardHopParams(nodeId, { ...rest, origin }),
    forwardTimeoutFor(action, timeoutMs),
  );
  const latencyMs = Date.now() - started;
  if (!res.success) {
    if (UNKNOWN_METHOD_RE.test(res.error ?? "")) {
      capsCache.delete(nodeId);
      const err = updateRequiredError(nodeId, action, negotiated.caps, ctx.nodeName);
      audit(false, { code: "NODE_UPDATE_REQUIRED", error: String(err.error) });
      return err;
    }
    audit(false, { code: res.code, error: res.error });
    return {
      ok: false,
      code: res.code ?? "FORWARD_FAILED",
      node: nodeId,
      error: res.error ?? `Failed to forward ui_control.invoke to node ${nodeId}`,
    };
  }
  const payload =
    res.payload && typeof res.payload === "object"
      ? res.payload
      : ({ payload: res.payload } as Record<string, unknown>);
  if (payload.ok === false && /^unknown action/i.test(coerceString(payload.error))) {
    const err = updateRequiredError(nodeId, action, negotiated.caps, ctx.nodeName);
    audit(false, { code: "NODE_UPDATE_REQUIRED", error: String(err.error) });
    return err;
  }
  audit(payload.ok !== false, {
    code: typeof payload.code === "string" ? payload.code : undefined,
    error: typeof payload.error === "string" ? payload.error : undefined,
  });
  return {
    ...payload,
    node: typeof payload.node === "string" ? payload.node : nodeId,
    latencyMs,
    ...(negotiated.caps.legacy ? { remoteProtocol: 1 } : {}),
  };
}

// ── cross-node listing ──────────────────────────────────────────────────────

export type UiWindow = {
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

export type UiNodeWindows = UiNodeInfo & {
  online: boolean;
  latencyMs?: number;
  protocol?: number;
  updateRequired?: boolean;
  error?: string;
  code?: string;
  windows: UiWindow[];
};

type TabRow = {
  connId: string;
  codename: string;
  label: string;
  title?: string;
  route?: string;
  focused?: boolean;
  visible?: boolean;
  lastSeenAt?: number;
};

function toWindows(node: UiNodeInfo, tabs: unknown): UiWindow[] {
  if (!Array.isArray(tabs)) return [];
  return (tabs as TabRow[])
    .filter((t) => t && typeof t.connId === "string")
    .map((t) => ({
      node: node.nodeId,
      nodeName: node.name,
      address: `${node.name}/${t.label || t.codename}`,
      connId: t.connId,
      codename: t.codename,
      label: t.label || t.codename,
      title: t.title,
      route: t.route,
      focused: t.focused,
      visible: t.visible,
      lastSeenAt: t.lastSeenAt,
      isLocal: node.isLocal,
    }));
}

/**
 * Every UI window on every reachable node: local tabs + each online peer's
 * `list_tabs`, with online/version/latency/protocol per node.
 */
export async function listWindowsAcrossNodes(ctx: {
  localNodeId: string;
  localName?: string;
  localTabs: () => TabRow[];
  roster?: UiNodeInfo[];
  forward?: ForwardFn;
  perNodeTimeoutMs?: number;
}): Promise<{ ok: true; localNode: string; nodes: UiNodeWindows[]; windows: UiWindow[] }> {
  const roster = ctx.roster ?? (await listFederationNodes());
  const localInfo: UiNodeInfo = roster.find((n) => n.isLocal) ?? {
    nodeId: ctx.localNodeId,
    name: ctx.localName ?? ctx.localNodeId,
    role: getFederationHub() ? "master" : getFederationSatellite() ? "satellite" : "standalone",
    isLocal: true,
    status: "online",
  };
  const local: UiNodeWindows = {
    ...localInfo,
    nodeId: ctx.localNodeId,
    online: true,
    latencyMs: 0,
    protocol: UI_CONTROL_PROTOCOL,
    windows: toWindows({ ...localInfo, nodeId: ctx.localNodeId }, ctx.localTabs()),
  };
  const peers = roster.filter((n) => !n.isLocal && n.nodeId !== ctx.localNodeId);
  const remote = await Promise.all(
    peers.map(async (peer): Promise<UiNodeWindows> => {
      const reachable =
        peer.status === "online" || peer.status === "connected" || peer.status === "registered";
      if (!reachable)
        return { ...peer, online: false, windows: [], error: `node is ${peer.status}` };
      const started = Date.now();
      const res = await withTimeout(
        forwardUiControl(
          peer.nodeId,
          { action: "list_tabs", timeoutMs: ctx.perNodeTimeoutMs },
          {
            localNodeId: ctx.localNodeId,
            localName: ctx.localName,
            nodeName: peer.name,
            forward: ctx.forward,
          },
        ),
        ctx.perNodeTimeoutMs ?? 10_000,
      );
      if (!res)
        return { ...peer, online: false, windows: [], error: "timed out", code: "NODE_TIMEOUT" };
      const caps = capsCache.get(peer.nodeId)?.caps;
      if (res.ok === false) {
        return {
          ...peer,
          online: res.code !== "NODE_UNREACHABLE",
          windows: [],
          error: coerceString(res.error, "failed"),
          code: typeof res.code === "string" ? res.code : undefined,
          protocol: caps?.protocol,
          updateRequired: res.code === "NODE_UPDATE_REQUIRED",
        };
      }
      return {
        ...peer,
        version: caps?.version ?? peer.version,
        online: true,
        latencyMs: typeof res.latencyMs === "number" ? res.latencyMs : Date.now() - started,
        protocol: caps?.protocol,
        updateRequired: (caps?.protocol ?? UI_CONTROL_PROTOCOL) < UI_CONTROL_PROTOCOL,
        windows: toWindows(peer, res.tabs),
      };
    }),
  );
  const nodes = [local, ...remote];
  return { ok: true, localNode: ctx.localNodeId, nodes, windows: nodes.flatMap((n) => n.windows) };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

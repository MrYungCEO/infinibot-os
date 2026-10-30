/**
 * UI Control bridge — bidirectional RPC between the agent (server-side) and
 * a connected browser UI client.
 *
 * Architecture (no protocol-schema change):
 *   1. Agent calls `dispatchToUI(view, action, args)` — runs in the same
 *      process as the gateway, so direct module access is fine.
 *   2. We allocate a requestId, store a pending Promise, and broadcast a
 *      `ui.request` event with `{ requestId, view, action, args }`.
 *   3. The browser's UIControlBus subscribes to `ui.request`, dispatches to
 *      the matching ViewController, and sends back `ui.response` via the
 *      regular client→server request channel.
 *   4. The `ui.response` handler resolves the pending Promise.
 *
 * The broadcast targets all clients with role "operator" + a webchat-style
 * client. First response wins; later duplicates are ignored. For v1 this is
 * fine since users typically have one InfiniBot UI open at a time.
 */

import { randomUUID } from "node:crypto";

import { loadConfig } from "../../config/config.js";
import { getScopedUserId } from "../../config/paths.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import {
  forwardUiControl,
  isUiLocalNode,
  listFederationNodes,
  listUiControlAudit,
  listWindowsAcrossNodes,
  localUiCapabilities,
  parseUiAddress,
  recordUiControlAudit,
  resolveNodeRef,
  resolveTargetNodeId,
  uiLocalNodeId,
  type UiControlOrigin,
} from "../ui-control-federation.js";
import type { GatewayBroadcaster } from "../server-broadcast.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  bindUiSession,
  forgetUiClient,
  getUiClientActivity,
  handleGuideAction,
  isGuideAction,
  noteUiClientActivity,
  pickGuideTabs,
  type GuideParams,
} from "../ui-guide.js";
import {
  getUiTarget,
  listUiTargets,
  resolveUiTarget,
  searchUiTargets,
} from "../../ui-targets/registry.js";

/* ─── module state ────────────────────────────────────────────────────── */

interface PendingRequest {
  resolve: (value: { ok: boolean; payload?: unknown; error?: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  view: string;
  action: string;
  /**
   * How many remaining stale-bundle answers we'll silently swallow before
   * accepting whatever's next. Each connected UI client gets the broadcast;
   * if one of them is running a pre-fix bundle it answers immediately with a
   * "gateway client not connected" / "unknown action" error and "wins" the
   * race against the fresh tab. We track this counter so we wait for a real
   * response from a healthy tab when staleness is detected.
   */
  staleSkipsRemaining: number;
  /**
   * Merge-mode requests collect responses from every UI client and resolve
   * with the "richest" one (most actions per view in list_views, etc.)
   * instead of first-responder-wins. Used when an older bundle returns
   * ok:true with outdated data — staleSkipsRemaining can't help there
   * because the response isn't shaped like an error.
   */
  mergeMode?: {
    expectedResponses: number;
    collected: Array<{ ok: boolean; payload?: unknown; error?: string }>;
    mergeTimer?: NodeJS.Timeout;
    pickBest: (responses: Array<{ ok: boolean; payload?: unknown; error?: string }>) => {
      ok: boolean;
      payload?: unknown;
      error?: string;
    };
  };
}

/**
 * For list_views: count total actions across every registered view. The
 * newer bundle has strictly more actions than older ones, so "most actions"
 * is a reliable freshness signal. Defaults to 0 on parse failures so a
 * malformed response loses to any valid one.
 */
function actionRichness(payload: unknown): number {
  if (!Array.isArray(payload)) return 0;
  let count = 0;
  for (const v of payload) {
    if (v && typeof v === "object" && "actions" in v) {
      const acts = (v as { actions?: unknown[] }).actions;
      if (Array.isArray(acts)) count += acts.length;
    }
  }
  return count;
}

const STALE_ERROR_PATTERNS = [
  /gateway client not connected/i,
  /unknown action:/i,
  // Controllers that gate on lazy-init state. Older bundles return these
  // before the auto-init code that newer bundles have. If any connected
  // client knows how to init, prefer its answer over the early-return.
  /not initialized/i,
];

/* ─── codenames ──────────────────────────────────────────────────────────
 * Each connected UI client gets a NATO phonetic codename ("Alpha", "Bravo",
 * etc.) for voice-friendly addressing. Users see the codename in their
 * window title (e.g. "[Alpha] InfiniBot") so they can say "open notes on
 * Alpha" instead of pasting a UUID. With 26 names and only a handful of
 * tabs collisions are rare in practice, but if two clients hash to the
 * same name we suffix with the disambiguator counter for whichever
 * connected second (Alpha, Alpha-2, Alpha-3).
 */
const NATO_PHONETIC = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "Xray",
  "Yankee",
  "Zulu",
];
function natoForConnId(connId: string): string {
  let h = 0;
  for (let i = 0; i < connId.length; i++) {
    h = (h << 5) - h + connId.charCodeAt(i);
    h |= 0;
  }
  return NATO_PHONETIC[Math.abs(h) % NATO_PHONETIC.length]!;
}
/**
 * Resolve a codename for every connected UI client, disambiguating
 * collisions with -2/-3 suffixes (older connections keep the bare name).
 * Returns a Map keyed by connId.
 */
function resolveCodenames(): Map<string, string> {
  const out = new Map<string, string>();
  if (!clientsRef) return out;
  // Deterministic order by connId so two callers get the same assignment.
  const uiClients = Array.from(clientsRef)
    .filter(isUIClient)
    .sort((a, b) => (a.connId < b.connId ? -1 : a.connId > b.connId ? 1 : 0));
  const taken = new Map<string, number>(); // base name → count
  for (const c of uiClients) {
    const base = natoForConnId(c.connId);
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    out.set(c.connId, n === 1 ? base : `${base}-${n}`);
  }
  return out;
}
/**
 * Public helper: find a connId by codename (case-insensitive). Used by
 * ui_control { tab: "Alpha" } and routing="active" parsing.
 */
export function findConnIdByCodename(codename: string): string | undefined {
  const target = codename.trim().toLowerCase();
  if (!target) return undefined;
  for (const [connId, name] of resolveCodenames()) {
    if (name.toLowerCase() === target) return connId;
  }
  return undefined;
}
/**
 * Public helper: find an instanceId by codename. Convenience wrapper that
 * also looks up the connected client's reported instanceId.
 */
export function findInstanceIdByCodename(codename: string): string | undefined {
  const connId = findConnIdByCodename(codename);
  if (!connId || !clientsRef) return undefined;
  for (const c of clientsRef) {
    if (c.connId === connId) return c.connect.client?.instanceId;
  }
  return undefined;
}

const pending = new Map<string, PendingRequest>();
const tabLabels = new Map<string, string>();
let broadcaster: GatewayBroadcaster | undefined;
let clientsRef: Set<GatewayWsClient> | undefined;

export function setUIControlBroadcaster(params: {
  broadcaster: GatewayBroadcaster;
  clients: Set<GatewayWsClient>;
}): void {
  broadcaster = params.broadcaster;
  clientsRef = params.clients;
}

export function getNodeId(): string {
  const cfg = loadConfig();
  const nodeId = cfg.federation?.nodeId;
  return typeof nodeId === "string" && nodeId.trim() ? nodeId.trim() : "local";
}

/* ─── types ──────────────────────────────────────────────────────────── */

export interface UIDispatchOptions {
  timeoutMs?: number;
  /**
   * WebSocket-unique target id. **Preferred over instanceId.** Two tabs
   * duplicated by the user share an instanceId (sessionStorage is copied),
   * so an instanceId-targeted dispatch would fire in both. Targeting by
   * connId disambiguates them deterministically. Use findConnIdByCodename
   * to resolve a voice-friendly codename to a connId.
   */
  connId?: string;
  /**
   * Legacy targeting field; matches every tab that shares this
   * sessionStorage id (broken for duplicated tabs). Kept for
   * back-compatibility with callers that resolve to instanceId only.
   */
  instanceId?: string;
}

export interface UIDispatchResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/* ─── public API (used by the agent tool, in-process) ────────────────── */

export function listConnectedUIClients(): Array<{
  connId: string;
  clientId?: string;
  instanceId?: string;
  role?: string;
  codename: string;
  label: string;
  nodeId: string;
  title?: string;
  route?: string;
  focused?: boolean;
  visible?: boolean;
  lastSeenAt?: number;
}> {
  const out: ReturnType<typeof listConnectedUIClients> = [];
  if (!clientsRef) return out;
  const codenames = resolveCodenames();
  const nodeId = getNodeId();
  for (const c of clientsRef) {
    if (!isUIClient(c)) continue;
    const codename = codenames.get(c.connId) ?? "Unknown";
    out.push({
      connId: c.connId,
      clientId: c.connect.client?.id,
      instanceId: c.connect.client?.instanceId,
      role: c.connect.role,
      codename,
      label: tabLabels.get(c.connId) ?? codename,
      nodeId,
      ...activityFields(c.connId),
    });
  }
  return out;
}

function activityFields(connId: string): {
  title?: string;
  route?: string;
  focused?: boolean;
  visible?: boolean;
  lastSeenAt?: number;
} {
  const a = getUiClientActivity(connId);
  if (!a) return {};
  return {
    title: a.title,
    route: a.route,
    focused: a.focused,
    visible: a.visible,
    lastSeenAt: a.lastSeenAt,
  };
}

export function setTabLabel(connId: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("label is required");
  tabLabels.set(connId, trimmed);
  broadcastTabsChanged();
}

export function clearTabLabel(connId: string): void {
  tabLabels.delete(connId);
  broadcastTabsChanged();
}

export function broadcastTabsChanged(): void {
  broadcaster?.broadcast("ui.tabs.changed", {
    nodeId: getNodeId(),
    tabs: listConnectedUIClients(),
  });
}

export function notifyUIClientConnected(client: GatewayWsClient): void {
  if (!isUIClient(client)) return;
  broadcastTabsChanged();
}

export function notifyUIClientDisconnected(client: GatewayWsClient): void {
  if (!isUIClient(client)) return;
  tabLabels.delete(client.connId);
  forgetUiClient(client.connId);
  broadcastTabsChanged();
}

export type UIControlInvokeParams = {
  action?: string;
  node?: string;
  /** Re-attached by forwardGatewayCall when a satellite tunnels via the master. */
  nodeId?: string;
  /** Alias of `tab`; also accepts the compound "node/Tab" address. */
  window?: string;
  /** Set by the forwarding node: who asked (audit + loop guard). */
  origin?: UiControlOrigin;
  /** mirror: the screen to show — `{ node, tab }` (node omitted = the caller's node). */
  source?: { node?: string; tab?: string; label?: string };
  connId?: string;
  instanceId?: string;
  tab?: string;
  label?: string;
  view?: string;
  op?: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  routing?: string;
  /** Guide actions: who's asking (the agent's session) → which tab gets it. */
  sessionKey?: string;
  target?: string;
  query?: string;
  scope?: string;
  agentName?: string;
};

/** UI clients visible to the current request scope (a cloud tenant sees only its own). */
export function scopedUIClients(): GatewayWsClient[] {
  if (!clientsRef) return [];
  const ns = getScopedUserId();
  return Array.from(clientsRef).filter((c) => isUIClient(c) && (!ns || c.saasNamespace === ns));
}

function resolveConnId(params: {
  connId?: string;
  instanceId?: string;
  tab?: string;
}): string | undefined {
  const connId = typeof params.connId === "string" ? params.connId.trim() : "";
  if (connId && clientsRef) {
    for (const c of clientsRef) {
      if (c.connId === connId && isUIClient(c)) return c.connId;
    }
  }

  const tab = typeof params.tab === "string" ? params.tab.trim() : "";
  if (tab) {
    const byCodename = findConnIdByCodename(tab);
    if (byCodename) return byCodename;
  }

  const instanceId = typeof params.instanceId === "string" ? params.instanceId.trim() : "";
  if (instanceId && clientsRef) {
    for (const c of clientsRef) {
      if (!isUIClient(c)) continue;
      if (c.connect.client?.instanceId === instanceId) return c.connId;
    }
  }

  return undefined;
}

export async function invokeUIControlAction(
  params: UIControlInvokeParams,
): Promise<Record<string, unknown>> {
  const action = typeof params.action === "string" ? params.action.trim() : "";
  const configNodeId = getNodeId();
  const localNodeId = uiLocalNodeId(configNodeId === "local" ? undefined : configNodeId);
  const address = parseUiAddress(params);
  const targetNode = address.node === "all" ? undefined : address.node;
  const local = { ...params, tab: address.tab, node: undefined, nodeId: undefined };

  if (action === "mirror") {
    // Pin the source to an absolute node id before the call leaves this node:
    // "local" means the CALLER's node, not the node that will show it.
    const src = parseUiAddress({ node: params.source?.node, tab: params.source?.tab });
    if (!src.tab) return { ok: false, code: "INVALID_REQUEST", error: "mirror needs source.tab" };
    const srcLocal = isUiLocalNode(src.node, configNodeId);
    const srcNode = srcLocal
      ? (params.origin?.nodeId ?? localNodeId)
      : await resolveTargetNodeId(src.node!);
    const srcName = (await listFederationNodes()).find((n) =>
      srcLocal ? n.isLocal : n.nodeId === srcNode,
    )?.name;
    local.source = {
      node: srcNode,
      tab: src.tab,
      label: params.source?.label || `${srcName ?? srcNode} · ${src.tab}`,
    };
  }

  if (targetNode && !isUiLocalNode(targetNode, configNodeId)) {
    if (getScopedUserId()) {
      return {
        ok: false,
        code: "FORBIDDEN",
        error: "Cross-node UI control is not available to hosted tenants.",
      };
    }
    const roster = await listFederationNodes();
    const resolved = resolveNodeRef(targetNode, roster);
    // Unknown names still get a forward attempt as a raw id (a sibling the
    // roster has not synced yet); the transport reports a precise error.
    const nodeId = "nodeId" in resolved ? resolved.nodeId : targetNode;
    if ("nodeId" in resolved && isUiLocalNode(nodeId, configNodeId)) {
      return invokeLocalUIControlAction({ ...local, action }, localNodeId);
    }
    if (!("nodeId" in resolved) && resolved.candidates.length > 0 && roster.length > 0) {
      const ambiguous = resolved.error.includes("ambiguous");
      if (ambiguous)
        return {
          ok: false,
          code: "AMBIGUOUS_NODE",
          error: resolved.error,
          candidates: resolved.candidates,
        };
    }
    const localName = roster.find((n) => n.isLocal)?.name;
    return forwardUiControl(
      nodeId,
      { ...local, action },
      {
        localNodeId,
        localName,
        nodeName: "node" in resolved ? resolved.node?.name : undefined,
      },
    );
  }

  const started = Date.now();
  const result = await invokeLocalUIControlAction(
    { ...local, action },
    localNodeId,
    address.node === "all",
  );
  const origin = params.origin;
  if (origin?.nodeId && origin.nodeId !== localNodeId) {
    recordUiControlAudit({
      at: started,
      direction: "inbound",
      fromNode: origin.nodeId,
      toNode: localNodeId,
      action,
      view: typeof params.view === "string" ? params.view : undefined,
      op: typeof params.op === "string" ? params.op : undefined,
      tab: address.tab,
      sessionKey: origin.sessionKey,
      ok: result.ok !== false,
      code: typeof result.code === "string" ? result.code : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
      latencyMs: Date.now() - started,
    });
  }
  return result;
}

async function invokeLocalUIControlAction(
  params: UIControlInvokeParams & { action: string },
  localNodeId: string,
  allNodes = false,
): Promise<Record<string, unknown>> {
  const action = params.action;

  if (action === "capabilities") {
    return { ok: true, ...(await localUiCapabilities(localNodeId)) };
  }
  if (
    action === "list_nodes" ||
    action === "list_windows" ||
    (action === "list_tabs" && allNodes)
  ) {
    const listing = await listWindowsAcrossNodes({
      localNodeId,
      localTabs: () => listConnectedUIClients(),
      perNodeTimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
    });
    if (action === "list_nodes") {
      return {
        ok: true,
        localNode: listing.localNode,
        nodes: listing.nodes.map(({ windows, ...n }) => ({ ...n, windowCount: windows.length })),
      };
    }
    return listing;
  }
  if (action === "audit") {
    return {
      ok: true,
      node: localNodeId,
      entries: listUiControlAudit({
        node: typeof params.args?.node === "string" ? params.args.node : undefined,
        limit: typeof params.args?.limit === "number" ? params.args.limit : undefined,
      }),
    };
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.trunc(params.timeoutMs)
      : undefined;
  let connId = resolveConnId(params);
  let routingNote: string | undefined;

  const tagResult = <T extends Record<string, unknown>>(r: T): T | (T & { routingNote: string }) =>
    routingNote ? { ...r, routingNote } : r;

  /**
   * Ordinary view RPCs use the same session/focus-aware tab picker as guide
   * actions. Historically these calls omitted connId, which made the gateway
   * broadcast nav.switch_tab/nav.open_page to every browser tab and merely
   * accept the first response. Always resolving to exact connIds here keeps a
   * caller's page change inside its own tab; scope='all' is the only fan-out.
   */
  const dispatchScoped = async (
    view: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const clients = scopedUIClients().map((c) => ({
      connId: c.connId,
      saasNamespace: c.saasNamespace,
      saasEmail: c.saasEmail,
      instanceId: c.connect.client?.instanceId,
    }));
    const hasExplicitTarget = Boolean(params.connId || params.instanceId || params.tab);
    const picked =
      params.routing === "first" && !hasExplicitTarget && params.scope !== "all"
        ? clients.length > 0
          ? { connIds: [clients[0]!.connId], how: "first connected tab" }
          : {
              error:
                "No InfiniBot window is open for this user. Ask them to open the InfiniBot web app, then try again.",
            }
        : pickGuideTabs(
            clients,
            {
              connId: params.connId,
              instanceId: params.instanceId,
              tab: params.tab,
              scope: params.scope === "all" ? "all" : "active",
              sessionKey: params.sessionKey,
            },
            findConnIdByCodename,
          );
    if ("error" in picked) {
      return { ok: false, code: "NO_UI_CLIENT", error: picked.error };
    }

    routingNote = `routed via ${picked.how} → ${picked.connIds.join(", ")}`;
    const results = await Promise.all(
      picked.connIds.map(async (targetConnId) => ({
        connId: targetConnId,
        ...(await dispatchToUI(view, op, args, { timeoutMs, connId: targetConnId })),
      })),
    );
    if (results.length === 1) {
      const only = results[0]!;
      return { ok: only.ok, payload: only.payload, error: only.error };
    }
    return {
      ok: results.every((result) => result.ok),
      payload: {
        results: results.map((result) => ({
          connId: result.connId,
          ok: result.ok,
          payload: result.payload,
          error: result.error,
        })),
      },
    };
  };

  if (isGuideAction(action)) {
    const codenames = resolveCodenames();
    return handleGuideAction(
      { ...(params as GuideParams), action, timeoutMs },
      {
        uiClients: () =>
          scopedUIClients().map((c) => ({
            connId: c.connId,
            saasNamespace: c.saasNamespace,
            saasEmail: c.saasEmail,
            instanceId: c.connect.client?.instanceId,
          })),
        resolveCodename: (name) => findConnIdByCodename(name),
        codenameOf: (id) => codenames.get(id),
        dispatch: (view, op, args, connId, ms) =>
          dispatchToUI(view, op, args, { connId, timeoutMs: ms }),
      },
    );
  }

  if (action === "list_clients") {
    return { clients: listConnectedUIClients() };
  }

  if (action === "list_tabs") {
    return { nodeId: localNodeId, tabs: listConnectedUIClients() };
  }

  if (action === "set_label") {
    const label = typeof params.label === "string" ? params.label.trim() : "";
    if (!label) return { ok: false, error: "label is required", code: "INVALID_REQUEST" };
    connId = resolveConnId(params);
    if (!connId) {
      return {
        ok: false,
        error: "target tab not found",
        available: listConnectedUIClients(),
      };
    }
    setTabLabel(connId, label);
    return { ok: true, nodeId: localNodeId, tab: connId, label };
  }

  if (action === "focus_tab") {
    connId = resolveConnId(params);
    if (!connId) {
      return {
        ok: false,
        error: "target tab not found",
        available: listConnectedUIClients(),
      };
    }
    const r = await dispatchToUI("window", "focus", {}, { timeoutMs, connId });
    return tagResult({ ...r, nodeId: localNodeId, tab: connId });
  }

  if (action === "list_views") {
    const r = await dispatchScoped("_meta", "list_views", {});
    return tagResult({ ...r });
  }

  if (action === "get_state") {
    const view = typeof params.view === "string" ? params.view.trim() : "";
    if (!view) return { ok: false, error: "view is required", code: "INVALID_REQUEST" };
    const r = await dispatchScoped(view, "get_state", { view });
    return tagResult({ ...r });
  }

  if (action === "dispatch") {
    const view = typeof params.view === "string" ? params.view.trim() : "";
    const op = typeof params.op === "string" ? params.op.trim() : "";
    if (!view) return { ok: false, error: "view is required", code: "INVALID_REQUEST" };
    if (!op) return { ok: false, error: "op is required", code: "INVALID_REQUEST" };
    const dispatchArgs =
      params.args && typeof params.args === "object" && !Array.isArray(params.args)
        ? params.args
        : {};
    const r = await dispatchScoped(view, op, dispatchArgs);
    return tagResult({ ...r });
  }

  if (action === "screenshot" || action === "window_state") {
    const a = params.args ?? {};
    const op = action === "screenshot" ? "screenshot" : "state";
    const r = await dispatchScoped("window", op, {
      maxWidth: typeof a.maxWidth === "number" ? a.maxWidth : undefined,
      quality: typeof a.quality === "number" ? a.quality : undefined,
    });
    return tagResult({ ...r, node: localNodeId });
  }

  if (action === "mirror") {
    const src = params.source ?? {};
    const r = await dispatchScoped("remote_screen", "open", {
      // The display window resolves the node from ITS gateway's point of view.
      node: src.node && src.node !== localNodeId ? src.node : "local",
      tab: src.tab,
      label: src.label,
      intervalMs: typeof params.args?.intervalMs === "number" ? params.args.intervalMs : undefined,
    });
    return tagResult({ ...r, node: localNodeId, source: src });
  }

  return { ok: false, error: `unknown action: ${action}` };
}

export async function dispatchToUI(
  view: string,
  action: string,
  args: Record<string, unknown> | undefined,
  opts: UIDispatchOptions = {},
): Promise<UIDispatchResult> {
  if (!broadcaster) {
    return { ok: false, error: "ui-control: broadcaster not initialized (gateway not started?)" };
  }
  if (!clientsRef || countUIClients(clientsRef) === 0) {
    return {
      ok: false,
      error:
        "ui-control: no UI client connected. Open the InfiniBot web UI in a browser to enable agent-driven UI control.",
    };
  }

  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // If there are multiple UI clients connected we may get answers from
  // stale tabs that haven't reloaded after a code change — they'll respond
  // immediately with `gateway client not connected` or `unknown action`
  // and beat the healthy tab to the punch. Pre-count how many other
  // clients there are so we can patiently skip up to that many stale-error
  // responses before giving up. The fresh client should answer within the
  // same timeout window.
  // A request targeted at one connection goes to that socket only (never a
  // broadcast every tab filters): no cross-tab duplicates, and in cloud mode
  // nothing reaches another tenant's browser.
  const targetClient = opts.connId
    ? Array.from(clientsRef).find((c) => c.connId === opts.connId && isUIClient(c))
    : undefined;
  if (opts.connId && !targetClient) {
    return { ok: false, error: `ui-control: tab ${opts.connId} is not connected` };
  }
  const totalUIClients = targetClient ? 1 : clientsRef ? countUIClients(clientsRef) : 0;
  const staleSkipsRemaining = Math.max(0, totalUIClients - 1);
  // For list_views: don't accept first-responder. Older bundles return
  // ok:true with a smaller (outdated) view list, which beats the newer
  // bundle in a race and convinces the agent that actions like
  // notes.open_by_name don't exist. Switch to merge-mode: collect every
  // response and resolve with the most action-rich one.
  const wantsMerge = action === "list_views";

  const promise = new Promise<UIDispatchResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      // If we were collecting and have at least one answer, return the best.
      if (entry?.mergeMode && entry.mergeMode.collected.length > 0) {
        resolve(entry.mergeMode.pickBest(entry.mergeMode.collected));
        return;
      }
      resolve({
        ok: false,
        error: `ui-control: timed out after ${timeoutMs}ms waiting for browser response (view=${view}, action=${action})`,
      });
    }, timeoutMs);
    pending.set(requestId, {
      resolve,
      reject,
      timer,
      view,
      action,
      staleSkipsRemaining,
      mergeMode: wantsMerge
        ? {
            expectedResponses: totalUIClients,
            collected: [],
            pickBest: (responses) => {
              // Drop errors; prefer richer payloads.
              const oks = responses.filter((r) => r.ok && r.payload !== undefined);
              if (oks.length === 0) return responses[0] ?? { ok: false, error: "no responses" };
              let best = oks[0]!;
              let bestScore = actionRichness(best.payload);
              for (const r of oks.slice(1)) {
                const s = actionRichness(r.payload);
                if (s > bestScore) {
                  best = r;
                  bestScore = s;
                }
              }
              return best;
            },
          }
        : undefined,
    });
  });

  const payload = {
    requestId,
    view,
    action,
    args: args ?? {},
    connId: opts.connId,
    instanceId: opts.instanceId,
  };
  if (targetClient) {
    try {
      targetClient.socket.send(JSON.stringify({ type: "event", event: "ui.request", payload }));
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      return { ok: false, error: `ui-control: send to tab failed: ${String(err)}` };
    }
  } else {
    broadcaster.broadcast("ui.request", payload);
  }

  return promise;
}

/* ─── handler: ui.response (browser → server) ────────────────────────── */

const uiControlHandlers: GatewayRequestHandlers = {
  "ui.response": async ({ req, respond }) => {
    const params = (req.params ?? {}) as {
      requestId?: unknown;
      ok?: unknown;
      payload?: unknown;
      error?: unknown;
    };
    if (typeof params.requestId !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "requestId required"));
      return;
    }
    const entry = pending.get(params.requestId);
    if (!entry) {
      // Already resolved / timed out / unknown id. Acknowledge anyway so
      // the browser doesn't think it failed to deliver.
      respond(true, { ignored: true });
      return;
    }
    const ok = params.ok === true;
    const errString = typeof params.error === "string" ? params.error : undefined;
    const response = { ok, payload: params.payload, error: errString };

    // Merge mode: collect every response, resolve with the best after a
    // short grace once we've heard from all expected clients (or the
    // outer timeout fires).
    if (entry.mergeMode) {
      entry.mergeMode.collected.push(response);
      respond(true, { collected: entry.mergeMode.collected.length });
      const reached = entry.mergeMode.collected.length >= entry.mergeMode.expectedResponses;
      const settle = () => {
        const e = pending.get(params.requestId as string);
        if (!e || !e.mergeMode) return;
        clearTimeout(e.timer);
        if (e.mergeMode.mergeTimer) clearTimeout(e.mergeMode.mergeTimer);
        pending.delete(params.requestId as string);
        e.resolve(e.mergeMode.pickBest(e.mergeMode.collected));
      };
      if (reached) {
        settle();
      } else if (!entry.mergeMode.mergeTimer) {
        // After the FIRST response, give other clients a brief window
        // (500ms) to chime in. Stale tabs answer fast; the new one might
        // be a tiny bit slower. 500ms balances responsiveness vs missing
        // the fresh answer.
        entry.mergeMode.mergeTimer = setTimeout(settle, 500);
      }
      return;
    }

    // If this is an error response that looks like it came from a stale
    // tab (older bundle missing the host.client rename, or missing newer
    // actions), and we know there are other clients that haven't answered
    // yet, swallow it and keep waiting. Most environments only run one UI
    // tab — this only kicks in when multiple are connected after a code
    // change, which is exactly when first-responder-wins hurts us.
    const looksStale =
      !ok &&
      !!errString &&
      entry.staleSkipsRemaining > 0 &&
      STALE_ERROR_PATTERNS.some((re) => re.test(errString));
    if (looksStale) {
      entry.staleSkipsRemaining -= 1;
      // Don't resolve. Don't clear the timer. Acknowledge the sender so
      // it doesn't retry. The pending entry stays alive until a healthy
      // tab answers or the original timeout fires.
      respond(true, { ignoredAsStale: true });
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(params.requestId);
    entry.resolve(response);
    respond(true, { accepted: true });
  },

  "ui.list_clients": async ({ respond }) => {
    respond(true, { clients: listConnectedUIClients() });
  },

  /** Browser presence: focus / visibility / interaction of the calling tab. */
  "ui.client.activity": async ({ params, respond, client }) => {
    const connId = (client as { connId?: string } | null)?.connId;
    if (!client || !connId || !isUIClient(client)) {
      respond(true, { ignored: true });
      return;
    }
    noteUiClientActivity(connId, {
      focused: typeof params.focused === "boolean" ? params.focused : undefined,
      visible: typeof params.visible === "boolean" ? params.visible : undefined,
      interacted: params.interacted === true,
      route: typeof params.route === "string" ? params.route : undefined,
      title: typeof params.title === "string" ? params.title : undefined,
    });
    respond(true, { ok: true });
  },

  /** UI target registry (read): every navigable place / highlightable control. */
  "ui.targets.list": async ({ params, respond }) => {
    const res = await listUiTargets({
      kind: typeof params.kind === "string" ? params.kind : undefined,
      plugin: typeof params.plugin === "string" ? params.plugin : undefined,
      prefix: typeof params.prefix === "string" ? params.prefix : undefined,
      available: typeof params.available === "boolean" ? params.available : undefined,
    });
    respond(true, { total: res.targets.length, cloud: res.env.cloud, targets: res.targets });
  },

  "ui.targets.search": async ({ params, respond }) => {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query required"));
      return;
    }
    const limit = typeof params.limit === "number" ? Math.max(1, Math.min(50, params.limit)) : 8;
    const [targets, resolved] = await Promise.all([
      searchUiTargets(query, { limit }),
      resolveUiTarget({ query }),
    ]);
    respond(true, {
      query,
      targets,
      best: resolved.ok
        ? {
            id: resolved.target.id,
            title: resolved.target.title,
            confidence: resolved.confidence,
            available: resolved.available,
            plan: resolved.plan,
          }
        : { ambiguous: resolved.reason === "ambiguous", candidates: resolved.candidates },
    });
  },

  "ui.targets.get": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const t = id ? await getUiTarget(id) : null;
    if (!t) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `unknown ui target: ${id}`));
      return;
    }
    const r = await resolveUiTarget({ target: t.id });
    respond(true, {
      target: t,
      plan: r.ok ? r.plan : undefined,
      available: r.ok ? r.available : undefined,
      unavailableReason: r.ok ? r.unavailableReason : undefined,
    });
  },

  "ui.list_tabs": async ({ respond }) => {
    respond(true, { nodeId: getNodeId(), tabs: listConnectedUIClients() });
  },

  "ui.set_tab_label": async ({ params, respond }) => {
    const label = typeof params.label === "string" ? params.label.trim() : "";
    if (!label) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "label is required"));
      return;
    }
    const connId = resolveConnId({
      connId: typeof params.connId === "string" ? params.connId : undefined,
      instanceId: typeof params.instanceId === "string" ? params.instanceId : undefined,
      tab: typeof params.tab === "string" ? params.tab : undefined,
    });
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "target tab not found"));
      return;
    }
    setTabLabel(connId, label);
    respond(true, { ok: true, nodeId: getNodeId(), tab: connId, label });
  },

  "ui.focus_tab": async ({ params, respond }) => {
    const connId = resolveConnId({
      connId: typeof params.connId === "string" ? params.connId : undefined,
      tab: typeof params.tab === "string" ? params.tab : undefined,
    });
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "target tab not found"));
      return;
    }
    const result = await dispatchToUI("window", "focus", {}, { connId });
    respond(result.ok, { ...result, nodeId: getNodeId(), tab: connId });
  },

  /**
   * Cross-node capability handshake. With `node`/`nodeId` it answers for that
   * peer (routing through the master like ui_control.invoke does).
   */
  "ui_control.capabilities": async ({ params, respond }) => {
    const { node } = parseUiAddress(params as UIControlInvokeParams);
    const configNodeId = getNodeId();
    const localNodeId = uiLocalNodeId(configNodeId === "local" ? undefined : configNodeId);
    const target =
      node && !isUiLocalNode(node, configNodeId) ? await resolveTargetNodeId(node) : "";
    if (target && !isUiLocalNode(target, configNodeId)) {
      const { getFederationHub } = await import("../../federation/hub.js");
      const hop = getFederationHub() ? {} : { node: target };
      const fwd = await forwardGatewayCall(target, "ui_control.capabilities", hop, 8_000);
      if (fwd.success) {
        respond(true, fwd.payload);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, fwd.error ?? `node ${node} unavailable`),
      );
      return;
    }
    respond(true, await localUiCapabilities(localNodeId));
  },

  /** Per-node log of cross-node ui_control actions (both directions). */
  "ui_control.audit": async ({ params, respond }) => {
    respond(true, {
      entries: listUiControlAudit({
        node: typeof params.node === "string" ? params.node : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      }),
    });
  },

  "ui_control.invoke": async ({ params, respond }) => {
    const result = await invokeUIControlAction(params as UIControlInvokeParams);
    respond(true, result);
  },

  /**
   * Returns the codename assigned to the *calling* connection. Uses the
   * WebSocket's connId (always unique per WS) rather than the instanceId
   * the client claims it has. This is critical when the user duplicates a
   * tab — both tabs end up with the same sessionStorage instanceId, so
   * matching on instanceId from ui.list_clients would give both tabs the
   * same codename. Using connId via the request context disambiguates them
   * deterministically: each tab asks "who am I?" and the server answers
   * based on which WebSocket the request arrived on.
   */
  "ui.my_codename": async ({ respond, client }) => {
    if (!client) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_LINKED, "no connection"));
      return;
    }
    const map = resolveCodenames();
    const codename = map.get(client.connId);
    respond(true, { codename: codename ?? null, connId: client.connId });
  },
};

export { uiControlHandlers };

/**
 * A UI tab made a request naming a chat session (chat.send / chat.history …):
 * remember that this conversation lives in that tab, so the agent's
 * highlights come back to it.
 */
export function noteUiRequestSession(
  client: { connId?: string; connect: GatewayWsClient["connect"] } | undefined | null,
  params: unknown,
): void {
  if (!client?.connId || !isUIClient(client)) return;
  const key = (params as { sessionKey?: unknown } | null)?.sessionKey;
  if (typeof key === "string" && key.trim()) bindUiSession(key, client.connId);
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function isUIClient(c: Pick<GatewayWsClient, "connect">): boolean {
  const clientId = c.connect.client?.id ?? "";
  const mode = c.connect.client?.mode ?? "";
  // The canonical browser client; webchat mode covers older builds. Either
  // is a valid UI target.
  if (clientId === "infinibot-control-ui" || clientId === "webchat-ui") return true;
  if (mode === "webchat") return true;
  return false;
}

function countUIClients(set: Set<GatewayWsClient>): number {
  let n = 0;
  for (const c of set) if (isUIClient(c)) n++;
  return n;
}

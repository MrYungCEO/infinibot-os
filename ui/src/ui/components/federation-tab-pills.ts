import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.js";
import { listFederationWindows } from "../federation-ui-control.js";
import { icons } from "../icons.js";
import "./device-switcher.js";

type FederationTab = {
  connId: string;
  clientId?: string;
  instanceId?: string;
  role?: string;
  codename: string;
  label: string;
  nodeId: string;
};

type FederationPillsState = AppViewState & {
  _fedTabs?: Map<string, FederationTab[]>;
  _fedNodeLabels?: Map<string, string>;
  _fedLocalNodeId?: string;
  _fedSelfConnId?: string;
  _fedTabsPending?: boolean;
  _fedTabsLoaded?: boolean;
  _fedTabsUnsub?: () => void;
  _fedTabsClient?: GatewayBrowserClient | null;
  _fedRenameKey?: string | null;
  _fedRenameValue?: string;
  _fedLongPressTimer?: number;
};

function stateFor(state: AppViewState): FederationPillsState {
  const s = state as FederationPillsState;
  s._fedTabs ??= new Map();
  s._fedNodeLabels ??= new Map();
  return s;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapToolDetails(value: unknown): unknown {
  const outer = asRecord(value);
  const result = asRecord(outer?.result);
  if (result && "details" in result) return result.details;
  const content = result?.content;
  if (Array.isArray(content)) {
    const first = asRecord(content[0]);
    if (typeof first?.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return null;
      }
    }
  }
  return value;
}

async function invokeUiControl(
  client: GatewayBrowserClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await client.request("agent.tools.invoke", {
    tool: "ui_control",
    args,
  });
  return unwrapToolDetails(res);
}

function renameKey(nodeId: string, tab: FederationTab): string {
  return `${nodeId}:${tab.codename}`;
}

function scheduleRefresh(state: FederationPillsState): void {
  if (state._fedTabsPending) return;
  state._fedTabsPending = true;
  void refreshFederationTabs(state).finally(() => {
    state._fedTabsPending = false;
    state._fedTabsLoaded = true;
    state.requestUpdate?.();
  });
}

async function refreshFederationTabs(state: FederationPillsState): Promise<void> {
  const client = state.client;
  if (!client) return;

  const self = await client
    .request<{ connId?: string }>("ui.my_codename", {})
    .catch(() => null);
  if (self?.connId) state._fedSelfConnId = self.connId;

  // One listing for every node (sat→sat included; older gateways fall back
  // to list_tabs + federation.nodes.list inside listFederationWindows).
  const listing = await listFederationWindows(client).catch(() => null);
  if (!listing) return;
  state._fedLocalNodeId = listing.localNode;
  state._fedTabs = new Map<string, FederationTab[]>();
  for (const node of listing.nodes) {
    state._fedNodeLabels?.set(node.nodeId, node.name || node.nodeId);
    if (!node.isLocal && !node.online) continue;
    state._fedTabs.set(
      node.nodeId,
      node.windows.map((w) => ({
        connId: w.connId,
        codename: w.codename,
        label: w.label,
        nodeId: node.nodeId,
      })),
    );
  }
}

function ensureFederationTabPills(state: FederationPillsState): void {
  if (!state.client) return;
  if (!state._fedTabsLoaded && !state._fedTabsPending) scheduleRefresh(state);
  if (state._fedTabsClient !== state.client) {
    state._fedTabsUnsub?.();
    state._fedTabsUnsub = undefined;
    state._fedTabsClient = state.client;
  }
  if (!state._fedTabsUnsub) {
    state._fedTabsUnsub = state.client.subscribe((evt: GatewayEventFrame) => {
      if (evt.event === "ui.tabs.changed") scheduleRefresh(state);
    });
  }
}

function startRename(state: FederationPillsState, nodeId: string, tab: FederationTab): void {
  state._fedRenameKey = renameKey(nodeId, tab);
  state._fedRenameValue = tab.label || tab.codename;
  state.requestUpdate?.();
}

function clearLongPress(state: FederationPillsState): void {
  if (!state._fedLongPressTimer) return;
  window.clearTimeout(state._fedLongPressTimer);
  state._fedLongPressTimer = undefined;
}

async function focusTab(state: FederationPillsState, nodeId: string, tab: FederationTab): Promise<void> {
  const client = state.client;
  if (!client) return;
  if (nodeId === state._fedLocalNodeId) {
    await client.request("ui.focus_tab", { connId: tab.connId }).catch(() => null);
  } else {
    await invokeUiControl(client, { action: "focus_tab", node: nodeId, tab: tab.codename }).catch(
      () => null,
    );
  }
}

async function commitRename(
  state: FederationPillsState,
  nodeId: string,
  tab: FederationTab,
): Promise<void> {
  const client = state.client;
  const label = (state._fedRenameValue ?? "").trim();
  state._fedRenameKey = null;
  if (!client || !label) {
    state.requestUpdate?.();
    return;
  }
  await invokeUiControl(client, {
    action: "set_label",
    node: nodeId === state._fedLocalNodeId ? undefined : nodeId,
    tab: tab.codename,
    label,
  }).catch(() => null);
  scheduleRefresh(state);
}

function renderSingleTabPill(
  s: FederationPillsState,
  nodeId: string,
  tab: FederationTab,
  extraClass: string,
  tooltip: string,
): ReturnType<typeof html> {
  const key = renameKey(nodeId, tab);
  const renaming = s._fedRenameKey === key;
  const nodeLabel = extraClass === "remote" ? (s._fedNodeLabels?.get(nodeId) ?? nodeId) : undefined;
  return html`
    <button
      class="pill federation-tab-pill ${extraClass}"
      data-node=${nodeId}
      data-tab=${tab.codename}
      title=${tooltip}
      @click=${() => (renaming ? undefined : focusTab(s, nodeId, tab))}
      @contextmenu=${(ev: Event) => {
        ev.preventDefault();
        startRename(s, nodeId, tab);
      }}
      @pointerdown=${() => {
        clearLongPress(s);
        s._fedLongPressTimer = window.setTimeout(() => startRename(s, nodeId, tab), 650);
      }}
      @pointerup=${() => clearLongPress(s)}
      @pointerleave=${() => clearLongPress(s)}
    >
      ${renaming
        ? html`<input
            class="federation-tab-rename"
            .value=${s._fedRenameValue ?? ""}
            @click=${(ev: Event) => ev.stopPropagation()}
            @input=${(ev: Event) => {
              s._fedRenameValue = (ev.target as HTMLInputElement).value;
            }}
            @keydown=${(ev: KeyboardEvent) => {
              if (ev.key === "Enter") void commitRename(s, nodeId, tab);
              if (ev.key === "Escape") {
                s._fedRenameKey = null;
                s.requestUpdate?.();
              }
            }}
            @blur=${() => commitRename(s, nodeId, tab)}
          />`
        : html`<span class="federation-tab-label">${tab.label}</span>`}
      ${nodeLabel ? html`<span class="node-badge">${nodeLabel}</span>` : nothing}
    </button>
  `;
}

/**
 * Render the top-bar tab identity pill.
 *
 * Resting state: ONE pill showing THIS tab's NATO codename ("self" pill).
 * The native tooltip (title attr) lists all other connected tabs so the user
 * can see what's open without cluttering the bar.
 * Long-press or right-click on the pill opens inline rename.
 *
 * Remote federation nodes are rendered as a separate always-visible cluster
 * (green border) so federation state remains at a glance.
 */
export function renderFederationTabPills(state: AppViewState): ReturnType<typeof html> {
  const s = stateFor(state);
  ensureFederationTabPills(s);

  const localNodeId = s._fedLocalNodeId ?? "local";
  const allEntries = Array.from(s._fedTabs ?? new Map<string, FederationTab[]>()).flatMap(([nodeId, tabs]) =>
    tabs.map((tab) => ({ nodeId, tab })),
  );

  if (!allEntries.length) return html`<div class="federation-tab-pills"></div>`;

  const selfEntry = allEntries.find(
    ({ nodeId, tab }) => nodeId === localNodeId && tab.connId === s._fedSelfConnId,
  );
  const otherLocalEntries = allEntries.filter(
    ({ nodeId, tab }) => nodeId === localNodeId && tab.connId !== s._fedSelfConnId,
  );
  const remoteEntries = allEntries.filter(({ nodeId }) => nodeId !== localNodeId);

  // Remote cluster — always shown regardless of self-detection state
  const remoteCluster = remoteEntries.map(({ nodeId, tab }) => {
    const nodeLabel = s._fedNodeLabels?.get(nodeId) ?? nodeId;
    return renderSingleTabPill(s, nodeId, tab, "remote", `${nodeLabel}: ${tab.label}`);
  });

  // Fallback: connId handshake not yet complete — show all local tabs (old behaviour)
  if (!selfEntry) {
    const localEntries = allEntries.filter(({ nodeId }) => nodeId === localNodeId);
    return html`
      <div class="federation-tab-pills" aria-label="Connected UI tabs">
        ${localEntries.map(({ nodeId, tab }) =>
          renderSingleTabPill(s, nodeId, tab, "", tab.label),
        )}
        ${remoteCluster}
      </div>
    `;
  }

  const { nodeId, tab } = selfEntry;

  // Build tooltip listing every other tab so the user can see them on hover
  const otherLines = [
    ...otherLocalEntries.map(({ tab: t }) => `Local: ${t.label}`),
    ...remoteEntries.map(({ nodeId: nid, tab: t }) => {
      const nl = s._fedNodeLabels?.get(nid) ?? nid;
      return `${nl}: ${t.label}`;
    }),
  ];
  const tooltip =
    otherLines.length > 0
      ? [`This tab: ${tab.label}`, ...otherLines].join("\n")
      : tab.label;

  return html`
    <div class="federation-tab-pills" aria-label="Connected UI tabs">
      ${renderSingleTabPill(s, nodeId, tab, "self", tooltip)}
      ${remoteCluster}
    </div>
  `;
}

/**
 * Top-bar "Devices" button: the device switcher as a popover on every page.
 * The popover is portalled to <body> — inside the top bar it would be clipped
 * (and the bar's overflow logic would fold the whole slot away).
 */
let devicesPop: HTMLElement | null = null;

function closeDevicesPop(): void {
  devicesPop?.remove();
  devicesPop = null;
  document.removeEventListener("keydown", onDevicesKey, true);
  document.removeEventListener("pointerdown", onDevicesOutside, true);
}

function onDevicesKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeDevicesPop();
}

function onDevicesOutside(e: Event): void {
  const path = e.composedPath();
  if (devicesPop && !path.includes(devicesPop) && !path.some((n) => (n as Element).classList?.contains?.("federation-devices-btn"))) {
    closeDevicesPop();
  }
}

function toggleDevicesPop(anchor: HTMLElement): void {
  if (devicesPop) {
    closeDevicesPop();
    return;
  }
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "federation-devices-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Devices");
  const width = Math.min(560, window.innerWidth - 24);
  // Drop down from the button; a detached/zero-size anchor falls back to top-right.
  const placed = r.width > 0 && r.height > 0;
  const left = placed
    ? Math.max(12, Math.min(r.left, window.innerWidth - width - 12))
    : window.innerWidth - width - 16;
  const top = placed ? r.bottom + 8 : 56;
  pop.style.cssText = `position:fixed;top:${Math.round(top)}px;left:${Math.round(left)}px;width:${width}px;z-index:2147482000;max-height:calc(100vh - ${Math.round(top + 16)}px);overflow:auto;border-radius:18px;background:rgba(11,10,8,.94);box-shadow:0 24px 60px rgba(0,0,0,.5)`;
  const sw = document.createElement("ib-device-switcher");
  sw.setAttribute("compact", "");
  pop.appendChild(sw);
  document.body.appendChild(pop);
  devicesPop = pop;
  document.addEventListener("keydown", onDevicesKey, true);
  document.addEventListener("pointerdown", onDevicesOutside, true);
}

/** Own control-bar slot (`data-cb-item="devices"`) so it outlives the pills when the bar is crowded. */
export function renderDevicesButton(): ReturnType<typeof html> {
  return html`
    <button
      class="pill federation-devices-btn"
      title="Devices: drive any window on any federation node"
      @click=${(e: Event) => toggleDevicesPop(e.currentTarget as HTMLElement)}
    >
      ${icons.monitor}<span class="federation-tab-label">Devices</span>
    </button>
  `;
}
